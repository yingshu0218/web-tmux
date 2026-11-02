import bcrypt from 'bcryptjs';
import { db, logOp, getSettings, setSettings, findUser, createSessionToken, verifySessionToken, deleteSessionToken, updateUserPassword } from './db.js';
import { encrypt } from './crypto.js';
import { getLiveStatus, exec, execQuiet } from './sshpool.js';
import { listSessions, listWindows, capturePane, createSession, killSession, validName, validLabel, tmuxVersion, checkLinger, fixLinger, checkLocale, checkSftp, pushTmuxConf, serverStats, setSessionMouse, applyTerminalSettings, normWindowSize, mouseForScrollMode, validSocketPath, renameSession, getSessionOptions, setSessionOptions, createWindow, renameWindow, killWindow, selectWindow } from './tmux.js';

const LOGIN_ATTEMPTS = new Map(); // ip -> {count, resetAt}

export function registerRoutes(app) {
  // ---- auth guard for /api/* except login ----
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/login')) return;
    const token = req.cookies?.tmuxweb_sid;
    const session = verifySessionToken(token);
    if (!session) return reply.code(401).send({ error: '未登录或会话已过期' });
    req.user = { id: session.user_id };
  });

  // ---- auth ----
  app.post('/api/login', async (req, reply) => {
    const ip = req.ip;
    const now = Date.now();
    const rec = LOGIN_ATTEMPTS.get(ip) || { count: 0, resetAt: now + 60_000 };
    if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 60_000; }
    if (++rec.count > 8) return reply.code(429).send({ error: '尝试过于频繁，请稍后再试' });
    LOGIN_ATTEMPTS.set(ip, rec);

    const { username, password } = req.body || {};
    if (!username || !password) return reply.code(400).send({ error: '缺少用户名或密码' });
    const user = findUser(String(username));
    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
      logOp('login_fail', `user=${username}`, ip);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    const s = getSettings();
    const { token, expires } = createSessionToken(user.id, s.loginTtlDays);
    reply.setCookie('tmuxweb_sid', token, { httpOnly: true, sameSite: 'lax', path: '/', expires: new Date(expires) });
    logOp('login_ok', `user=${user.username}`, ip);
    return { ok: true, username: user.username };
  });

  app.post('/api/logout', async (req, reply) => {
    deleteSessionToken(req.cookies?.tmuxweb_sid);
    reply.clearCookie('tmuxweb_sid', { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const row = db.prepare('SELECT username FROM users WHERE id = ?').get(req.user.id);
    return { username: row?.username, totpEnabled: getSettings().totpEnabled };
  });

  app.post('/api/me/password', async (req, reply) => {
    const { oldPassword, newPassword } = req.body || {};
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!oldPassword || !bcrypt.compareSync(String(oldPassword), row.password_hash)) return reply.code(400).send({ error: '原密码错误' });
    if (!newPassword || String(newPassword).length < 6) return reply.code(400).send({ error: '新密码至少 6 位' });
    updateUserPassword(row.id, bcrypt.hashSync(String(newPassword), 10));
    logOp('password_change', `user=${row.username}`, req.ip);
    return { ok: true };
  });

  // ---- servers CRUD ----
  const serverCols = 'id, name, host, port, username, auth_type, fingerprint, created_at';

  app.get('/api/servers', async () => {
    const rows = db.prepare(`SELECT ${serverCols} FROM servers ORDER BY id`).all();
    const counts = db.prepare('SELECT COUNT(*) AS c FROM op_logs').get().c;
    return { servers: rows.map(r => ({ ...r, live: getLiveStatus(r.id) })), logsTotal: counts };
  });

  function validateServerBody(body) {
    const { name, host, username } = body || {};
    if (!name || String(name).length > 64) throw new Error('名称不合法');
    if (!host || String(host).length > 255) throw new Error('地址不合法');
    if (!username || String(username).length > 64) throw new Error('用户名不合法');
    const port = Number(body.port) || 22;
    if (port < 1 || port > 65535) throw new Error('端口不合法');
    if (body.auth_type === 'password' && !body.password) throw new Error('缺少密码');
    if (body.auth_type !== 'password' && !body.privateKey) throw new Error('缺少私钥');
    return true;
  }

  app.post('/api/servers', async (req, reply) => {
    try { validateServerBody(req.body); } catch (e) { return reply.code(400).send({ error: e.message }); }
    const b = req.body;
    const info = db.prepare(`INSERT INTO servers (name, host, port, username, auth_type, private_key_enc, password_enc, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      b.name, b.host, Number(b.port) || 22, b.username, b.auth_type === 'password' ? 'password' : 'key',
      b.auth_type === 'password' ? null : encrypt(String(b.privateKey)),
      b.auth_type === 'password' ? encrypt(String(b.password)) : null,
      Date.now()
    );
    logOp('server_add', `${b.name} (${b.host})`, req.ip);
    return { id: info.lastInsertRowid };
  });

  app.put('/api/servers/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    if (!row) return reply.code(404).send({ error: '服务器不存在' });
    const b = req.body || {};
    const name = b.name ?? row.name, host = b.host ?? row.host;
    const port = Number(b.port ?? row.port), username = b.username ?? row.username;
    const authType = b.auth_type === 'password' ? 'password' : b.auth_type === 'key' ? 'key' : row.auth_type;
    db.prepare('UPDATE servers SET name=?, host=?, port=?, username=?, auth_type=? WHERE id=?')
      .run(String(name), String(host), port, String(username), authType, id);
    if (b.password && authType === 'password') db.prepare('UPDATE servers SET password_enc=? WHERE id=?').run(encrypt(String(b.password)), id);
    if (b.privateKey && authType === 'key') db.prepare('UPDATE servers SET private_key_enc=? WHERE id=?').run(encrypt(String(b.privateKey)), id);
    if (b.host !== undefined || b.port !== undefined || b.username !== undefined) {
      db.prepare('UPDATE servers SET fingerprint=? WHERE id=?').run(null, id); // re-TOFU on endpoint change
    }
    logOp('server_edit', String(name), req.ip);
    return { ok: true };
  });

  app.delete('/api/servers/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT name FROM servers WHERE id = ?').get(id);
    if (!row) return reply.code(404).send({ error: '服务器不存在' });
    db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    logOp('server_delete', row.name, req.ip);
    return { ok: true, note: '仅删除管理端记录与凭据，目标机上的 tmux 会话不受影响' };
  });

  // ---- access check (wizard step 3) ----
  app.post('/api/servers/:id/check', async (req, reply) => {
    const id = Number(req.params.id);
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    const items = [];
    const fresh = { ...server };

    // 1. ssh auth + connection
    try {
      await exec(fresh, 'true', 12000);
      const e = getLiveStatus(id);
      items.push({ key: 'ssh', label: 'SSH 连通与认证', ok: true, detail: `${server.host}:${server.port}` });
      // 2. fingerprint
      const row = db.prepare('SELECT fingerprint FROM servers WHERE id = ?').get(id);
      items.push({ key: 'fingerprint', label: '主机指纹已确认', ok: true, detail: row.fingerprint || 'SHA256:（首次连接已记录）' });
    } catch (err) {
      items.push({ key: 'ssh', label: 'SSH 连通与认证', ok: false, detail: String(err.message || err) });
      return { items, passed: false };
    }

    // 3. tmux
    const tmux = await tmuxVersion(fresh);
    items.push({ key: 'tmux', label: tmux.ok ? `tmux 已安装（${tmux.version}）` : 'tmux 未安装', ok: tmux.ok, detail: tmux.path || '未找到 tmux 可执行文件' });

    // 4. linger
    const linger = await checkLinger(fresh);
    items.push({ key: 'linger', label: linger.ok ? 'linger 已开启' : 'linger 未开启', ok: linger.ok, detail: linger.value, fix: linger.ok ? null : 'fix-linger' });

    // 5. locale
    const locale = await checkLocale(fresh);
    items.push({ key: 'locale', label: locale.ok ? 'locale 为 UTF-8' : 'locale 非 UTF-8', ok: locale.ok, detail: locale.value });

    // 6. sftp
    const sftp = await checkSftp(fresh);
    items.push({ key: 'sftp', label: sftp.ok ? 'SFTP 子系统可用' : 'SFTP 不可用', ok: sftp.ok, detail: sftp.value, warnOnly: true });

    const coreKeys = ['linger', 'tmux', 'locale'];
    const passed = coreKeys.every(k => items.find(i => i.key === k)?.ok);
    return { items, passed };
  });

  app.post('/api/servers/:id/fix-linger', async (req) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    const r = await fixLinger(server);
    logOp('fix_linger', server.name, req.ip);
    return r;
  });

  app.post('/api/servers/:id/push-tmux-conf', async (req) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    const r = await pushTmuxConf(server, getSettings());
    logOp('push_tmux_conf', server.name, req.ip);
    return r;
  });

  // 单个会话的滚轮模式：view=查看输出（tmux mouse on）/ keys=历史输入（mouse off）
  app.post('/api/servers/:id/scroll', async (req, reply) => {
    const id = Number(req.params.id);
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    const session = String(req.body?.session || '');
    const mode = req.body?.mode === 'keys' ? 'keys' : 'view';
    const rawSocket = String(req.body?.socket || '');
    const socket = validSocketPath(rawSocket) ? rawSocket : '';
    try {
      const r = await setSessionMouse(server, session, mouseForScrollMode(mode), socket);
      logOp('scroll_mode', `${server.name}:${socket ? socket + '/' : ''}${session}=${mode}`, req.ip);
      return { ...r, mode };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.get('/api/servers/:id/tmux-version', async (req, reply) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    return tmuxVersion(server);
  });

  app.get('/api/servers/:id/stats', async (req, reply) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    const live = getLiveStatus(server.id);
    if (live.state !== 'online') return { state: live.state, latency: live.latency, stats: null };
    try {
      const stats = await serverStats(server);
      return { state: 'online', latency: live.latency, stats };
    } catch (e) {
      return { state: live.state, latency: live.latency, stats: null, error: String(e.message || e) };
    }
  });

  // ---- sessions ----
  app.get('/api/sessions', async () => {
    const servers = db.prepare('SELECT * FROM servers ORDER BY id').all();
    const result = await Promise.all(servers.map(async s => {
      const live = getLiveStatus(s.id);
      let sessions = [], sockets = [];
      if (live.state === 'online') {
        try { ({ sessions, sockets } = await listSessions(s)); } catch { /* offline */ }
      }
      return { serverId: s.id, serverName: s.name, host: s.host, port: s.port, username: s.username, live, sessions, sockets };
    }));
    return { groups: result };
  });

  // 会话的 socket 定位：query 里带 socket= 表示非默认 tmux socket（别的用户 / tmux -L 命名 socket）
  function querySocket(req) {
    const raw = String(req.query.socket || '');
    return validSocketPath(raw) ? raw : '';
  }

  app.get('/api/sessions/preview', async (req) => {
    const serverId = Number(req.query.serverId);
    const session = String(req.query.session || '');
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server || !validName(session)) return { text: '', activity: null };
    const r = await capturePane(server, session, 10, querySocket(req));
    return r;
  });

  app.get('/api/servers/:id/windows', async (req) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!server) return { windows: [] };
    return { windows: await listWindows(server, String(req.query.session || ''), querySocket(req)) };
  });

  app.post('/api/servers/:id/sessions', async (req, reply) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    try {
      // 新建会话固定落在默认 socket（管理台自己管理的那套），不往别人的 socket 里塞
      await createSession(server, String(req.body?.name || ''), req.body?.dir ? String(req.body.dir) : undefined);
      logOp('session_create', `${server.name}:${req.body?.name}`, req.ip);
      return { ok: true };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.delete('/api/servers/:id/sessions/:name', async (req, reply) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    try { await killSession(server, req.params.name, querySocket(req)); } catch (e) { return reply.code(400).send({ error: e.message }); }
    logOp('session_kill', `${server.name}:${req.params.name}`, req.ip);
    return { ok: true };
  });

  // 重命名会话。管理台不持久化会话记录（每次实时 list），所以只改 tmux 里的名字，无 DB 副作用；
  // 但已 attach 的客户端**不会断开** —— 前端需要把指向旧名的标签同步改名。
  app.patch('/api/servers/:id/sessions/:name', async (req, reply) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    const newName = String(req.body?.name || '').trim();
    if (!validName(newName)) return reply.code(400).send({ error: '新会话名不合法（字母数字开头，可含 . _ -，最长 64 字符）' });
    try {
      const r = await renameSession(server, req.params.name, newName, querySocket(req));
      if (!r.unchanged) logOp('session_rename', `${server.name}:${req.params.name}→${r.name}`, req.ip);
      return r;
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  // 会话级可调参数（白名单在 tmux.js 的 SESSION_OPT_SPEC，非法键被忽略）
  app.get('/api/servers/:id/sessions/:name/options', async (req, reply) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    try { return { options: await getSessionOptions(server, req.params.name, querySocket(req)) }; }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.put('/api/servers/:id/sessions/:name/options', async (req, reply) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    try {
      const r = await setSessionOptions(server, req.params.name, req.body || {}, querySocket(req));
      logOp('session_options', `${server.name}:${req.params.name} ${Object.keys(req.body || {}).join(',')}`, req.ip);
      return r;
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  // 窗口管理：新建 / 重命名 / 关闭。
  // 关掉最后一个窗口时 tmux 会连带结束会话 —— 后端把 lastWindow 回报给前端做强告警。
  app.post('/api/servers/:id/sessions/:name/windows', async (req, reply) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    const winName = req.body?.name == null ? '' : String(req.body.name).trim();
    if (winName && !validLabel(winName)) return reply.code(400).send({ error: '窗口名不合法（1-64 字符，不含控制字符）' });
    try {
      const r = await createWindow(server, req.params.name, winName, querySocket(req));
      logOp('window_create', `${server.name}:${req.params.name}${winName ? `/${winName}` : ''}`, req.ip);
      return r;
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.patch('/api/servers/:id/sessions/:name/windows/:index', async (req, reply) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    const winName = String(req.body?.name || '').trim();
    if (!validLabel(winName)) return reply.code(400).send({ error: '窗口名不合法（1-64 字符，不含控制字符）' });
    try {
      const r = await renameWindow(server, req.params.name, Number(req.params.index), winName, querySocket(req));
      logOp('window_rename', `${server.name}:${req.params.name}:${req.params.index}→${winName}`, req.ip);
      return r;
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  // 切换当前窗口。注意这是**会话级**操作：所有连到该会话的客户端都会跟着切
  app.post('/api/servers/:id/sessions/:name/windows/:index/select', async (req, reply) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    try {
      const r = await selectWindow(server, req.params.name, Number(req.params.index), querySocket(req));
      logOp('window_select', `${server.name}:${req.params.name}:${req.params.index}`, req.ip);
      return r;
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.delete('/api/servers/:id/sessions/:name/windows/:index', async (req, reply) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!server) return reply.code(404).send({ error: '服务器不存在' });
    try {
      const r = await killWindow(server, req.params.name, Number(req.params.index), querySocket(req));
      logOp('window_kill', `${server.name}:${req.params.name}:${req.params.index}${r.lastWindow ? ' (会话随之结束)' : ''}`, req.ip);
      return r;
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  // ---- settings & logs ----
  app.get('/api/settings', async () => getSettings());
  app.put('/api/settings', async (req) => {
    const patch = { ...(req.body || {}) };
    // window-size 走白名单归一化，避免任意串落到 tmux 命令上
    if ('windowSize' in patch) patch.windowSize = normWindowSize(patch.windowSize);
    setSettings(patch);
    const after = getSettings();

    // 只要本次提交涉及终端类配置（滚轮 / 历史行数 / 窗口尺寸策略），就下发一次
    // （值没变也下发，便于首次统一全量生效）
    const termChanged = 'scrollDefault' in patch || 'historyLimit' in patch || 'windowSize' in patch;
    if (termChanged) {
      const servers = db.prepare('SELECT * FROM servers').all();
      const applied = await Promise.all(servers.map(async s => {
        if (getLiveStatus(s.id).state !== 'online') return { id: s.id, ok: false, skipped: true };
        try { return { id: s.id, ...(await applyTerminalSettings(s, after)) }; }
        catch { return { id: s.id, ok: false }; }
      }));
      logOp('terminal_apply', applied.map(a => `${a.id}:${a.ok ? 'ok' : a.skipped ? 'offline' : 'fail'}`).join(' '), req.ip);
    }
    logOp('settings_update', Object.keys(patch).join(','), req.ip);
    return after;
  });
  app.get('/api/logs', async (req) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = db.prepare('SELECT * FROM op_logs ORDER BY id DESC LIMIT ?').all(limit);
    return { logs: rows };
  });
}
