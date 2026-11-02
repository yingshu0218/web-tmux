import { exec, execQuiet } from './sshpool.js';

export function validName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name);
}

function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

const SEP = '~|~'; // printable separator — tmux replaces control chars with '_' in format output
const MOUSE_MARK = '@@MOUSE@@';
const MODE_MARK = '@@MODE@@';
const SOCK_MARK = '@@SOCK@@';

/**
 * socket 路径白名单校验。socket 会拼进远端 shell 命令，且本服务常以 root 运行，
 * 所以这里做的是「形状白名单」而不是转义兜底：绝对路径、只允许安全字符、不含 ..
 */
export function validSocketPath(p) {
  return typeof p === 'string'
    && p.length <= 200
    && /^\/[A-Za-z0-9._\/-]+$/.test(p)
    && !p.includes('..');
}

/** 拼出 ` -S '<path>'`；未指定或非法一律返回空串（= 默认 socket，行为与改造前一致） */
export function sockArg(socket) {
  return validSocketPath(socket) ? `-S ${q(socket)}` : '';
}

// 滚轮模式 -> tmux mouse 选项。view=查看输出（由 tmux 接管滚轮，进 copy-mode 翻历史）
//                                   keys=历史输入（滚轮被终端译为 ↑↓ 送进 pane）
export function mouseForScrollMode(mode) {
  return mode === 'keys' ? 'off' : 'on';
}

export function clampHistory(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return 10000;
  return Math.max(100, Math.min(n, 1_000_000));
}

/**
 * 列出该服务器上**所有 tmux socket** 里的会话，不只本管理台连的那个默认 socket。
 *
 * tmux 的会话按 socket 隔离：`/tmp/tmux-<uid>/default` 是每个用户的默认 socket，
 * `tmux -L <name>` 会落在同目录下的另一个文件，`tmux -S <path>` 则完全自定义。
 * 只查默认 socket 会漏掉其它用户 / 命名 socket 上跑着的会话。
 *
 * 一次 exec 返回：每个 socket 的会话列表 + 每会话显式 mouse 值 + 是否处于 copy-mode。
 * socket 为空串表示「当前 SSH 用户的默认 socket」，此时前端按默认处理（不带 -S）。
 */
export async function listSessions(server) {
  const cmd = `ME=$(id -u)
DEF="/tmp/tmux-$ME/default"
[ -n "$TMUX_TMPDIR" ] && DEF="$TMUX_TMPDIR/tmux-$ME/default"
SOCKETS=$( { ls -1 /tmp/tmux-*/* 2>/dev/null; [ -n "$TMUX_TMPDIR" ] && ls -1 "$TMUX_TMPDIR"/tmux-*/* 2>/dev/null; } | sort -u )
for so in $SOCKETS; do
  [ -S "$so" ] || continue
  if [ "$so" = "$DEF" ]; then SOCK=""; else SOCK="$so"; fi
  OWNER=$(stat -c '%U' "$so" 2>/dev/null || ls -ld "$so" 2>/dev/null | awk '{print $3}')
  [ -z "$OWNER" ] && OWNER="?"
  LS=$(tmux -S "$so" list-sessions -F '#{session_name}${SEP}#{session_windows}${SEP}#{session_attached}${SEP}#{session_created}${SEP}#{session_activity}${SEP}#{session_path}' 2>/dev/null)
  # 死 socket（tmux server 已退出但文件残留）与空 socket 都跳过：没会话的 socket 没有展示价值
  [ -z "$LS" ] && continue
  echo "${SOCK_MARK}$SOCK${SEP}$OWNER"
  printf '%s\\n' "$LS"
  echo '${MOUSE_MARK}'
  for s in $(tmux -S "$so" list-sessions -F '#{session_name}' 2>/dev/null); do
    printf '%s${SEP}%s\\n' "$s" "$(tmux -S "$so" show-options -t "$s" -v mouse 2>/dev/null)"
  done
  echo '${MODE_MARK}'
  tmux -S "$so" list-panes -a -F '#{session_name}${SEP}#{pane_in_mode}' 2>/dev/null || true
done`;
  const { stdout } = await execQuiet(server, cmd, 15000);

  const sessions = [];
  const sockets = [];
  let blk = null;
  let section = 'list';
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(SOCK_MARK)) {
      const [sock, owner] = line.slice(SOCK_MARK.length).split(SEP);
      blk = { socket: sock || null, owner: owner || '?', mouse: new Map(), mode: new Map(), count: 0 };
      sockets.push({ socket: blk.socket, owner: blk.owner, sessions: 0 });
      section = 'list';
      continue;
    }
    if (!blk) continue;
    if (line.trim() === MOUSE_MARK) { section = 'mouse'; continue; }
    if (line.trim() === MODE_MARK) { section = 'mode'; continue; }
    if (!line.trim()) continue;

    if (section === 'list') {
      const [name, windows, attached, created, activity, sessionPath] = line.split(SEP);
      if (!name) continue;
      sessions.push({
        name,
        windows: Number(windows) || 1,
        attached: Number(attached) || 0,
        created: Number(created) * 1000 || null,
        lastActivity: Number(activity) * 1000 || null,
        path: sessionPath || '',
        socket: blk.socket,
        socketOwner: blk.owner,
        mouse: null,
        inMode: false,
        _blk: blk // 临时引用，函数返回前删除
      });
      blk.count += 1;
      sockets[sockets.length - 1].sessions = blk.count;
    } else if (section === 'mouse') {
      const [n, v] = line.split(SEP);
      if (n) blk.mouse.set(n, (v || '').trim() || null);
    } else if (section === 'mode') {
      const [n, v] = line.split(SEP);
      if (n && !blk.mode.has(n)) blk.mode.set(n, (v || '').trim() === '1'); // 只取该会话第一个 pane
    }
  }
  // 回填 mouse / inMode —— 这两段排在会话列表之后，解析完才能查表
  for (const s of sessions) {
    const b = s._blk;
    delete s._blk;
    if (!b) continue;
    s.mouse = b.mouse.has(s.name) ? b.mouse.get(s.name) : null;
    s.inMode = b.mode.get(s.name) ?? false;
  }
  return { sessions, sockets };
}

// 设置单个会话的滚轮模式（会话级显式值，覆盖全局）
export async function setSessionMouse(server, session, mouse, socket) {
  if (!validName(session)) throw new Error('会话名不合法');
  const v = mouse === 'off' ? 'off' : 'on';
  const S = sockArg(socket);
  const cmd = `tmux ${S} set-option -t ${q(session)} mouse ${v} 2>&1 && echo SET-OK`;
  const { stdout } = await execQuiet(server, cmd, 10000);
  if (!stdout.includes('SET-OK')) {
    throw new Error((stdout.trim().split('\n').pop() || '设置失败').replace(/^tmux:\s*/, ''));
  }
  return { ok: true, mouse: v };
}

// 把滚轮模式 / 历史行数 / 窗口尺寸策略应用到整台服务器（全局 + 每个已存在会话）。
// 刻意**只作用于默认 socket**：其它 socket 上的会话属于别的用户/工具，不该被本管理台改写。
//
// 注意 window-size 只设全局（`-g`），**不逐个会话设** —— 会话级那项在无客户端连接时会被
// tmux 重置，设了也是白设。想持久化则走 pushTmuxConf（写 ~/.tmux.conf，见 buildTmuxConf）。
export async function applyTerminalSettings(server, settings = {}) {
  const mouse = mouseForScrollMode(settings.scrollDefault);
  const hl = clampHistory(settings.historyLimit);
  const ws = normWindowSize(settings.windowSize);
  const cmd = `tmux set-option -g mouse ${mouse} 2>/dev/null
tmux set-option -g history-limit ${hl} 2>/dev/null
tmux set-option -g window-size ${ws} 2>/dev/null
for s in $(tmux list-sessions -F '#{session_name}' 2>/dev/null); do
  tmux set-option -t "$s" mouse ${mouse} 2>/dev/null
done
echo APPLIED`;
  const { stdout } = await execQuiet(server, cmd, 15000);
  return { ok: stdout.includes('APPLIED'), mouse, historyLimit: hl, windowSize: ws };
}

export async function listWindows(server, session, socket) {
  if (!validName(session)) return [];
  const S = sockArg(socket);
  const { stdout } = await execQuiet(server, `tmux ${S} list-windows -t ${q(session)} -F '#{window_index}${SEP}#{window_name}${SEP}#{window_active}' 2>/dev/null || true`, 10000);
  return stdout.split('\n').filter(Boolean).map(l => {
    const [index, name, active] = l.split(SEP);
    return { index: Number(index), name, active: active === '1' };
  });
}

export async function capturePane(server, session, lines = 10, socket) {
  if (!validName(session)) return { text: '', activity: null };
  const S = sockArg(socket);
  // capture visible pane, drop blank lines (fresh panes anchor content at top), keep last N
  const cmd = `tmux ${S} capture-pane -pe -t ${q(session)} 2>/dev/null | sed '/^[[:space:]]*$/d' | tail -n ${lines}; echo "@@$(tmux ${S} list-sessions -F '#{session_activity}' -f '#{==:#{session_name},${session}}' 2>/dev/null)"`;
  const { stdout } = await execQuiet(server, cmd, 10000);
  const out = stdout.split('\n');
  const markerIdx = out.findIndex(l => l.startsWith('@@'));
  if (markerIdx === -1) return { text: stdout.replace(/\n+$/, ''), activity: null };
  const activity = Number(out[markerIdx].slice(2)) * 1000 || null;
  const text = out.slice(0, markerIdx).join('\n').replace(/\n+$/, '');
  return { text, activity };
}

export async function createSession(server, name, dir) {
  if (!validName(name)) throw new Error('会话名不合法');
  const { code, stderr } = await execQuiet(server, `tmux has-session -t ${q(name)} 2>/dev/null && echo EXISTS || tmux new-session -d -s ${q(name)}${dir ? ` -c ${q(dir)}` : ''}`, 12000);
  if (code !== 0 && !String(stderr).includes('EXISTS')) throw new Error(stderr || '创建失败');
}

export async function killSession(server, name, socket) {
  if (!validName(name)) throw new Error('会话名不合法');
  const S = sockArg(socket);
  // ⚠️ 这里曾经写成 `... 2>/dev/null; echo DONE-${code}` —— 模板串在 const 解构**完成之前**求值，
  //    访问 code 会直接抛 ReferenceError: Cannot access 'code' before initialization（TDZ）。
  //    后果：终止会话从头到尾没成功过一次（op_logs 里 session_kill 长期为 0），
  //    而且报错发生在发起 ssh 之前，目标机根本收不到命令。改成用远端的 $? 回传。
  const script = `if ! tmux ${S} has-session -t ${q(name)} 2>/dev/null; then echo 'ERR-会话不存在或已被其它操作终止'; exit 0; fi
OUT=$(tmux ${S} kill-session -t ${q(name)} 2>&1) && echo 'OK-KILLED' || echo "ERR-$OUT"`;
  const { stdout } = await execQuiet(server, script, 12000);
  const line = stdout.split('\n').map(l => l.trim()).filter(Boolean).pop() || '';
  if (!line.startsWith('OK-')) {
    throw new Error(line.replace(/^ERR-/, '').replace(/^tmux:\s*/, '') || '终止会话失败');
  }
  return { ok: true };
}

/**
 * 窗口名 / 一般文本标签的校验。
 * 比 validName 宽松（tmux 窗口名允许空格与中文），但仍然拒绝空串、超长与控制字符；
 * 拼进命令时统一走 q() 转义，这里做的是形状约束而非转义兜底。
 */
export function validLabel(s, max = 64) {
  return typeof s === 'string' && s.length >= 1 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
}

/**
 * 会话级可调选项白名单。
 * 前端字段名 -> { tmux 选项名, 取值归一化 }。**只允许这张表里的键落到 tmux 命令上**，
 * 避免把前端传来的任意字符串拼成 `set-option`。
 *
 * window-size 特别说明：管理台是浏览器客户端，尺寸必然与真实终端不同。
 * 默认（latest）下管理台 attach 会把自身尺寸推给 tmux，可能挤坏对方正在用的画面；
 * 多客户端观察场景更适合 largest（取最大）或 manual（不自动改窗口尺寸）。
 */
const SESSION_OPT_SPEC = {
  historyLimit: { opt: 'history-limit', norm: v => String(clampHistory(v)) },
  windowSize: {
    opt: 'window-size',
    norm: v => (['latest', 'largest', 'smallest', 'manual'].includes(String(v)) ? String(v) : 'latest')
  },
  destroyUnattached: {
    opt: 'destroy-unattached',
    norm: v => (v === true || v === 1 || v === 'on' ? 'on' : 'off')
  },
  mouse: { opt: 'mouse', norm: v => (v === false || v === 'off' ? 'off' : 'on') }
};

/** 会话级窗口尺寸策略的合法取值（路由层做入参校验用） */
export const WINDOW_SIZE_VALUES = ['latest', 'largest', 'smallest', 'manual'];

/** 归一化服务器级 window-size：非法值一律退回 latest（白名单，避免把任意串拼进 tmux 命令） */
export function normWindowSize(v) {
  return WINDOW_SIZE_VALUES.includes(String(v)) ? String(v) : 'latest';
}

// 读会话选项：同时取「会话级显式值」与「全局值」——
// tmux 未显式设置时会话选项为空（继承全局），只读会话级会把 UI 显示成一片空白。
async function readSessionOptions(server, session, socket) {
  const S = sockArg(socket);
  const opts = Object.values(SESSION_OPT_SPEC).map(s => s.opt);
  const script = opts
    .map(o => `printf '%s~|~%s~|~%s\\n' ${q(o)} "$(tmux ${S} show-options -t ${q(session)} -v ${q(o)} 2>/dev/null)" "$(tmux ${S} show-options -g -v ${q(o)} 2>/dev/null)"`)
    .join('\n');
  const { stdout } = await execQuiet(server, script, 12000);
  const got = {};
  for (const line of stdout.split('\n')) {
    const [opt, sv, gv] = line.split('~|~');
    if (opt) got[opt] = { session: (sv || '').trim(), global: (gv || '').trim() };
  }
  const out = {};
  for (const [key, spec] of Object.entries(SESSION_OPT_SPEC)) {
    const rec = got[spec.opt] || { session: '', global: '' };
    out[key] = {
      value: rec.session || rec.global || null, // 生效值
      explicit: rec.session !== '',             // 是否会话级显式设置
      global: rec.global || null
    };
  }
  return out;
}

/** 读单个会话的可调参数（含是否显式设置、全局值，供 UI 展示「继承」） */
export async function getSessionOptions(server, session, socket) {
  if (!validName(session)) throw new Error('会话名不合法');
  return readSessionOptions(server, session, socket);
}

/** 批量设置单个会话的选项；patch 里出现白名单之外的键会被忽略 */
export async function setSessionOptions(server, session, patch = {}, socket) {
  if (!validName(session)) throw new Error('会话名不合法');
  const entries = Object.entries(SESSION_OPT_SPEC)
    .filter(([k]) => patch[k] !== undefined && patch[k] !== null)
    .map(([k, spec]) => [spec.opt, spec.norm(patch[k])]);
  if (!entries.length) throw new Error('没有可设置的选项');

  const S = sockArg(socket);
  // 逐项设置、逐项报告失败：tmux 对未知选项会返回非零但不一定中断整条命令
  const script = entries
    .map(([opt, val]) => `tmux ${S} set-option -t ${q(session)} ${q(opt)} ${q(val)} 2>&1 || echo "ERR-${opt}"`)
    .join('\n');
  const { stdout } = await execQuiet(server, `${script}\necho MARK-DONE`, 15000);
  const errs = stdout.split('\n').filter(l => l.startsWith('ERR-')).map(l => l.slice(4));
  if (errs.length) throw new Error(`设置失败：${errs.join('、')}`);
  if (!stdout.includes('MARK-DONE')) throw new Error('设置未执行完成');
  return { ok: true, options: await readSessionOptions(server, session, socket) };
}

/** 重命名会话。目标名已存在时明确报错，不覆盖（tmux 本身也会拒绝，但错误信息不友好） */
export async function renameSession(server, oldName, newName, socket) {
  if (!validName(oldName)) throw new Error('原会话名不合法');
  if (!validName(newName)) throw new Error('新会话名不合法（字母数字开头，可含 . _ -，最长 64 字符）');
  if (oldName === newName) return { ok: true, name: newName, unchanged: true };

  const S = sockArg(socket);
  const script = `if ! tmux ${S} has-session -t ${q(oldName)} 2>/dev/null; then echo 'ERR-源会话不存在'; exit 0; fi
if tmux ${S} has-session -t ${q(newName)} 2>/dev/null; then echo 'ERR-该 socket 上已存在同名会话'; exit 0; fi
OUT=$(tmux ${S} rename-session -t ${q(oldName)} ${q(newName)} 2>&1) && echo 'OK-RENAMED' || echo "ERR-$OUT"`;
  const { stdout } = await execQuiet(server, script, 12000);
  const line = stdout.split('\n').map(l => l.trim()).filter(Boolean).pop() || '';
  if (!line.startsWith('OK-')) {
    throw new Error(line.replace(/^ERR-/, '').replace(/^tmux:\s*/, '') || '重命名失败');
  }
  return { ok: true, name: newName };
}

// ---- 窗口管理 ----
// 说明：kill-window 关掉会话的最后一个窗口时，tmux 会连带结束整个会话。
// 这里不拦截（用户可能确实想）—— 而是把「是否最后一个」回报给前端做告警。

export async function createWindow(server, session, name, socket) {
  if (!validName(session)) throw new Error('会话名不合法');
  if (name && !validLabel(name)) throw new Error('窗口名不合法');
  const S = sockArg(socket);
  // 末尾冒号 = 追加到窗口列表末尾，而不是插在当前位置
  const script = `tmux ${S} new-window -t ${q(`${session}:`)}${name ? ` -n ${q(name)}` : ''} 2>&1 && echo 'OK-NEWWINDOW'`;
  const { stdout } = await execQuiet(server, script, 15000);
  if (!stdout.includes('OK-NEWWINDOW')) {
    throw new Error((stdout.trim().split('\n').pop() || '新建窗口失败').replace(/^tmux:\s*/, ''));
  }
  return { ok: true, windows: await listWindows(server, session, socket) };
}

export async function renameWindow(server, session, index, name, socket) {
  if (!validName(session)) throw new Error('会话名不合法');
  if (!Number.isInteger(Number(index)) || Number(index) < 0) throw new Error('窗口序号不合法');
  if (!validLabel(name)) throw new Error('窗口名不合法');
  const S = sockArg(socket);
  const script = `tmux ${S} rename-window -t ${q(`${session}:${index}`)} ${q(name)} 2>&1 && echo 'OK-RENAMEWINDOW'`;
  const { stdout } = await execQuiet(server, script, 12000);
  if (!stdout.includes('OK-RENAMEWINDOW')) {
    throw new Error((stdout.trim().split('\n').pop() || '重命名窗口失败').replace(/^tmux:\s*/, ''));
  }
  return { ok: true, windows: await listWindows(server, session, socket) };
}

export async function killWindow(server, session, index, socket) {
  if (!validName(session)) throw new Error('会话名不合法');
  if (!Number.isInteger(Number(index)) || Number(index) < 0) throw new Error('窗口序号不合法');
  const S = sockArg(socket);
  const before = await listWindows(server, session, socket);
  const target = before.find(w => w.index === Number(index));
  if (!target) throw new Error('窗口不存在（可能已被其它操作关闭）');
  // 只剩一个窗口时，tmux 会连同会话一起结束 —— 回报给前端做强告警
  const lastWindow = before.length <= 1;
  const script = `tmux ${S} kill-window -t ${q(`${session}:${index}`)} 2>&1 && echo 'OK-KILLWINDOW'`;
  const { stdout } = await execQuiet(server, script, 12000);
  if (!stdout.includes('OK-KILLWINDOW')) {
    throw new Error((stdout.trim().split('\n').pop() || '关闭窗口失败').replace(/^tmux:\s*/, ''));
  }
  return {
    ok: true,
    lastWindow,
    killed: { index: target.index, name: target.name },
    // 关掉最后一个窗口后会话已消失，此时再 list 会失败 —— 直接返回空数组
    windows: lastWindow ? [] : await listWindows(server, session, socket)
  };
}

export async function tmuxVersion(server) {
  const { code, stdout } = await execQuiet(server, `command -v tmux >/dev/null 2>&1 && tmux -V || true`, 10000);
  if (code === 0 && stdout.trim()) {
    const m = stdout.trim().match(/tmux\s+([\d.]+[a-z]?)/i);
    return { ok: true, version: m ? m[1] : stdout.trim(), path: (await execQuiet(server, 'command -v tmux', 8000)).stdout.trim() };
  }
  return { ok: false, version: null, path: null };
}

export async function checkLinger(server) {
  const { stdout } = await execQuiet(server, `loginctl show-user "$(whoami)" -p Linger --value 2>/dev/null || echo unknown`, 10000);
  const v = stdout.trim();
  return { ok: v === 'yes', value: v };
}

export async function fixLinger(server) {
  const { code, stdout, stderr } = await execQuiet(server, `loginctl enable-linger "$(whoami)" 2>&1 || sudo -n loginctl enable-linger "$(whoami)" 2>&1`, 15000);
  const after = await checkLinger(server);
  return { ok: after.ok, output: (stdout + stderr).trim() };
}

export async function checkLocale(server) {
  // non-interactive exec does not load profile; use login shell to read real locale
  const { stdout } = await execQuiet(server, `bash -lc 'echo "$LANG"; locale charmap' 2>/dev/null || locale charmap 2>/dev/null || echo unknown`, 10000);
  return { ok: /UTF-?8/i.test(stdout), value: stdout.trim().split('\n').pop() || stdout.trim() };
}

export async function checkSftp(server) {
  const conn = await (await import('./sshpool.js')).connect(server);
  return new Promise(resolve => {
    conn.sftp((err) => resolve({ ok: !err, value: err ? String(err.message) : 'ok' }));
  });
}

export async function serverStats(server) {
  const script = `
read -r _ u1 n1 s1 i1 io1 _ < /proc/stat 2>/dev/null
t1=$((u1+n1+s1+i1+io1)); id1=$((i1+io1))
sleep 1
read -r _ u2 n2 s2 i2 io2 _ < /proc/stat 2>/dev/null
t2=$((u2+n2+s2+i2+io2)); id2=$((i2+io2))
if [ "$t2" -gt "$t1" ] 2>/dev/null; then echo "cpu_pct=$(( 100*(t2-t1-id2+id1)/(t2-t1) ))"; else echo "cpu_pct=0"; fi
echo "load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
echo "cores=$(nproc 2>/dev/null || echo 1)"
echo "uptime_s=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)"
free -b 2>/dev/null | awk '/^Mem:/{print "mem_total="$2; print "mem_used="$3; print "mem_avail="$7}'
df -Pk / 2>/dev/null | awk 'NR==2{print "disk_total="$2; print "disk_used="$3; print "disk_pct="$5}'
`;
  const { stdout } = await execQuiet(server, script, 15000);
  const kv = {};
  for (const line of stdout.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (m) kv[m[1]] = m[2];
  }
  return {
    cpuPct: Number(kv.cpu_pct) || 0,
    load: kv.load || '—',
    cores: Number(kv.cores) || 1,
    uptimeS: Number(kv.uptime_s) || 0,
    mem: { total: Number(kv.mem_total) || 0, used: Number(kv.mem_used) || 0, avail: Number(kv.mem_avail) || 0 },
    disk: { total: Number(kv.disk_total) || 0, used: Number(kv.disk_used) || 0, pct: parseInt(kv.disk_pct, 10) || 0 }
  };
}

/** 切换当前窗口（select-window）。会话级操作：会影响所有连到该会话的客户端。 */
export async function selectWindow(server, session, index, socket) {
  if (!validName(session)) throw new Error('会话名不合法');
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) throw new Error('窗口序号不合法');
  const S = sockArg(socket);
  const script = `tmux ${S} select-window -t ${q(`${session}:${i}`)} 2>&1 && echo 'OK-SELECTWINDOW'`;
  const { stdout } = await execQuiet(server, script, 12000);
  if (!stdout.includes('OK-SELECTWINDOW')) {
    throw new Error((stdout.trim().split('\n').pop() || '切换窗口失败').replace(/^tmux:\s*/, ''));
  }
  return { ok: true, index: i, windows: await listWindows(server, session, socket) };
}

export function buildTmuxConf(settings = {}) {
  return `# tmux-web managed base config
set -g history-limit ${clampHistory(settings.historyLimit)}
set -g mouse ${mouseForScrollMode(settings.scrollDefault)}
set -g window-size ${normWindowSize(settings.windowSize)}
set -g base-index 0
setw -g pane-base-index 0
set -sg escape-time 10
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -g status-style "bg=default,fg=white"
set -g status-left "#[fg=green]#S "
set -g status-right "%H:%M"
`;
}

// 下发基准配置：写 ~/.tmux.conf（首次备份原文件）并 source 让运行中的 server 立即生效
export async function pushTmuxConf(server, settings = {}) {
  const conf = buildTmuxConf(settings);
  const cmd = `B="$HOME/.tmux.conf"
[ -f "$B" ] && cp -n "$B" "$B.tw-bak" 2>/dev/null
cat > "$B" <<'TW_CONF_EOF'
${conf}TW_CONF_EOF
SRC=$(tmux source-file "$B" 2>&1 | head -3)
echo "CONF-OK:$B"
[ -n "$SRC" ] && echo "SOURCE:$SRC"
true`;
  const { stdout, code } = await execQuiet(server, cmd, 15000);
  if (!stdout.includes('CONF-OK:')) throw new Error('写入 tmux 配置失败（HOME 不可写？）');
  const path = stdout.split('CONF-OK:')[1].split('\n')[0].trim();
  const sourceErr = stdout.includes('SOURCE:') ? stdout.split('SOURCE:')[1].split('\n')[0].trim() : '';
  return { ok: code === 0, path, sourceError: sourceErr || null };
}
