import { connect } from './sshpool.js';
import { getSettings } from './db.js';
import { validName, validSocketPath, sockArg } from './tmux.js';

function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/**
 * attach 用的 tmux 前缀：`-u` 强制 UTF-8。
 *
 * ssh exec 是**非交互**的，环境里没有 LANG/LC_ALL（实测 `locale charmap` = ANSI_X3.4-1968）。
 * tmux 会据此认为 client 不支持 UTF-8，于是把 pane 里的宽字符（中文）**输出成 `_` 占位** ——
 * pane 内部存的是正确的 UTF-8 字节（capture-pane 可验证），只有 attach 到浏览器的这条链路被替换。
 * `-u` 是 tmux 官方的强制 UTF-8 开关，不依赖服务器装了哪个 locale。
 *
 * 顺带在存在 C.UTF-8 时导出 locale：这样管理台新建的会话里，子进程也按 UTF-8 运行。
 * 加了 grep 探测是刻意的 —— 服务器没有该 locale 时导出会让 shell 打印 setlocale 警告。
 */
const UTF8_ENV = `if locale -a 2>/dev/null | grep -qi '^C\\.utf-\\?8$'; then export LANG=C.UTF-8 LC_ALL=C.UTF-8; fi; `;

function buildCommand(mode, session, scroll, socket) {
  if (mode === 'shell') return null; // uses conn.shell()
  const name = q(session);
  const T = `tmux -u ${sockArg(socket)}`.replace(/\s+/g, ' ').trim(); // -u = 强制 UTF-8；sockArg 为空即默认 socket
  // 仅当该会话没有显式 mouse 设置时，按前端指定的滚轮模式写入；
  // 已有显式值（用户在终端页手动切换过）保持不动，尊重用户选择。
  const preset = (scroll === 'view' || scroll === 'keys')
    ? `${T} has-session -t ${name} 2>/dev/null && [ -z "$(${T} show-options -t ${name} -v mouse 2>/dev/null)" ] && ${T} set-option -t ${name} mouse ${scroll === 'keys' ? 'off' : 'on'} 2>/dev/null; `
    : '';
  if (mode === 'readonly') return `${UTF8_ENV}${preset}exec ${T} attach -r -t ${name}`;
  if (mode === 'exclusive') return `${UTF8_ENV}${preset}${T} detach-client -s ${name} 2>/dev/null; exec ${T} attach -t ${name}`;
  return `${UTF8_ENV}${preset}exec ${T} new-session -A -t ${name}`;
}

export function registerTerminalWs(app) {
  app.get('/ws/terminal', { websocket: true }, async (socket, req) => {
    const { verifySessionToken } = await import('./db.js');
    const session = verifySessionToken(req.cookies?.tmuxweb_sid);
    if (!session) { socket.close(4401, 'unauthorized'); return; }

    const serverId = Number(req.query.serverId);
    const mode = ['attach', 'readonly', 'exclusive', 'shell'].includes(req.query.mode) ? req.query.mode : 'attach';
    const sessionName = String(req.query.session || '');
    const scroll = req.query.scroll === 'keys' ? 'keys' : req.query.scroll === 'view' ? 'view' : '';
    // 非默认 tmux socket 上的会话（别的用户 / tmux -L 命名 socket）
    const rawSocket = String(req.query.socket || '');
    const sockPath = validSocketPath(rawSocket) ? rawSocket : '';
    const { db } = await import('./db.js');
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) { socket.close(4404, 'no such server'); return; }
    if (mode !== 'shell' && !validName(sessionName)) { socket.close(4400, 'bad session name'); return; }

    let conn;
    try { conn = await connect(server); } catch (err) {
      socket.send(JSON.stringify({ t: 'err', d: `SSH 连接失败: ${err.message || err}` }));
      socket.close(4502, 'ssh failed');
      return;
    }

    const cols = Math.max(Number(req.query.cols) || 120, 20);
    const rows = Math.max(Number(req.query.rows) || 32, 6);
    const opts = { term: 'xterm-256color', cols, rows };

    /*
     * 输出通道的两种格式，按前端能力协商（`?bin=1`）。
     *
     * 旧格式：每个 SSH 数据块一条 `{t:'d', d: base64}` 文本帧。三个问题——
     *   ① 高频小包（`seq`、构建日志这类输出会触发成百上千条消息）
     *   ② base64 让体积 +33%
     *   ③ 浏览器侧要 atob 再逐字节循环解码（见 Terminal.tsx 的 b64ToBytes）
     * 新格式：累积到 ~16ms（约一帧）合并成一个 Buffer，用**二进制帧**直发，前端直接喂 xterm。
     *
     * 为什么做协商而不是直接换：部署时前后端可能瞬时不一致（源码覆盖与 restart 之间、
     * 或用户浏览器缓存着旧 JS）。做了协商，**任意新旧组合都能正常工作**，不会中途黑屏。
     */
    const USE_BINARY = req.query.bin === '1';
    const COALESCE_MS = 16;
    const COALESCE_MAX = 256 * 1024; // 单次合并上限：洪流输出时不让内存无界堆积

    let pending = [];
    let pendingBytes = 0;
    let flushTimer = null;

    const flush = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (pending.length === 0) return;
      // 单块时直接发原 Buffer，省一次拷贝
      const out = pending.length === 1 ? pending[0] : Buffer.concat(pending);
      pending = [];
      pendingBytes = 0;
      if (socket.readyState === socket.OPEN) {
        try { socket.send(out); } catch { /* noop */ }
      }
    };

    const onStreamData = buf => {
      if (socket.readyState !== socket.OPEN) return;
      if (!USE_BINARY) {
        socket.send(JSON.stringify({ t: 'd', d: buf.toString('base64') }));
        return;
      }
      // 拷贝一份再持有：ssh2 解出来的 payload 可能是 socket 读缓冲的**视图**
      // （`new Uint8Array(data.buffer, data.byteOffset + p, nb)`）。原来「收到即发」不需要
      // 关心这件事，现在要持有可能长达 16ms，就把这个假设消掉 —— 成本是 16ms 一次 memcpy。
      pending.push(Buffer.from(buf));
      pendingBytes += buf.length;
      if (pendingBytes >= COALESCE_MAX) { flush(); return; } // 到上限立刻发，不等定时器
      if (!flushTimer) flushTimer = setTimeout(flush, COALESCE_MS);
    };

    const finish = () => {
      if (socket.readyState === socket.OPEN) { try { socket.close(1000); } catch { /* noop */ } }
    };

    const done = (err, stream) => {
      if (err) {
        socket.send(JSON.stringify({ t: 'err', d: `打开终端失败: ${err.message || err}` }));
        socket.close(4503, 'exec failed');
        return;
      }
      stream.on('data', onStreamData);
      stream.stderr.on('data', onStreamData);
      stream.on('close', () => {
        flush(); // 先把最后一段输出吐出去，再发「已退出」，否则结尾会丢
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ t: 'x' }));
        finish();
      });

      // ws -> pty
      socket.on('message', raw => {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString();
        let msg;
        try { msg = JSON.parse(text); } catch { return; }
        if (msg.t === 'i' && typeof msg.d === 'string') {
          stream.write(msg.d);
        } else if (msg.t === 'r') {
          const c = Math.max(Number(msg.c) || cols, 20);
          const r = Math.max(Number(msg.r) || rows, 6);
          try { stream.setWindow(r, c, 0, 0); } catch { /* noop */ }
        }
      });

      // heartbeat: wsPing / wsTimeout from settings
      const s = getSettings();
      let lastPong = Date.now();
      socket.on('pong', () => { lastPong = Date.now(); });
      const pingTimer = setInterval(() => {
        if (socket.readyState !== socket.OPEN) { cleanup(); return; }
        socket.ping();
        if (Date.now() - lastPong > s.wsTimeout * 1000) { cleanup(); finish(); }
      }, s.wsPing * 1000);

      function cleanup() {
        clearInterval(pingTimer);
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        pending = [];
        pendingBytes = 0;
      }

      socket.on('close', () => {
        cleanup();
        try { stream.end(); setTimeout(() => { try { stream.close(); } catch { /* noop */ } }, 300); } catch { /* noop */ }
      });
    };

    if (mode === 'shell') {
      conn.shell(opts, done);
    } else {
      conn.exec(buildCommand(mode, sessionName, scroll, sockPath), { pty: opts }, done);
    }
  });
}
