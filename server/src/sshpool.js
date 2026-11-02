import { Client } from 'ssh2';
import { db } from './db.js';
import { decrypt, sha256Fingerprint } from './crypto.js';
import { getSettings } from './db.js';

// serverId -> { conn, connecting, ident, status: {state, latency, failCount, lastCheck, lastError} }
const pool = new Map();

export function getLiveStatus(serverId) {
  const e = pool.get(serverId);
  if (!e) return { state: 'offline', latency: null, failCount: 0, lastCheck: null, lastError: null, ident: null };
  return { ...e.status, ident: e.ident || null };
}

function initEntry(serverId) {
  if (!pool.has(serverId)) {
    pool.set(serverId, { conn: null, connecting: null, ident: null, status: { state: 'offline', latency: null, failCount: 0, lastCheck: null, lastError: null } });
  }
  return pool.get(serverId);
}

/**
 * 抓一次远端的**实际身份**（登录后 effective uid，不一定等于配置里的 username）。
 *
 * 为什么需要它：tmux 的会话按 socket 隔离在 `/tmp/tmux-<uid>/` 下，
 * root 能看到全部用户的 tmux 会话，普通用户只能看到自己的。
 * 页面上必须能说清「现在是以谁的身份在看」，否则「某些会话看不到」会被误当成 bug。
 * 只在连接就绪时抓一次，不进入任何轮询循环（零额外常驻开销）。
 */
function fetchIdent(entry, conn) {
  try {
    conn.exec('id -un 2>/dev/null; id -u 2>/dev/null', (err, stream) => {
      if (err) return;
      let out = '';
      stream.on('data', d => { out += d.toString(); });
      stream.on('close', () => {
        const [user, uid] = out.trim().split('\n').map(x => (x || '').trim());
        if (user) entry.ident = { user, uid: Number(uid) >= 0 ? Number(uid) : null };
      });
    });
  } catch { /* 身份抓取失败不影响主链路 */ }
}

function authConfig(server) {
  const cfg = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: 12000,
    keepaliveInterval: getSettings().heartbeatInterval * 1000,
    keepaliveCountMax: getSettings().heartbeatFails
  };
  if (server.auth_type === 'password') {
    cfg.password = decrypt(server.password_enc);
  } else {
    let key = decrypt(server.private_key_enc);
    if (key && !key.endsWith('\n')) key += '\n';
    cfg.privateKey = key;
  }
  return cfg;
}

export function connect(server) {
  const entry = initEntry(server.id);
  if (entry.conn && entry.conn._ready) return Promise.resolve(entry.conn);
  if (entry.connecting) return entry.connecting;

  entry.connecting = new Promise((resolve, reject) => {
    const conn = new Client();
    entry.conn = conn;
    let settled = false;

    conn.on('ready', () => {
      conn._ready = true;
      entry.status = { state: 'online', latency: null, failCount: 0, lastCheck: Date.now(), lastError: null };
      fetchIdent(entry, conn); // 抓远端实际身份（异步，不阻塞连接就绪）
      if (!settled) { settled = true; resolve(conn); }
    });

    conn.on('close', () => {
      conn._ready = false;
      if (entry.conn === conn) {
        entry.conn = null;
        entry.connecting = null;
        if (entry.status.state === 'online') entry.status.state = 'reconnecting';
      }
    });

    conn.on('error', err => {
      entry.status.lastError = String(err.message || err);
      if (entry.conn === conn) entry.conn = null;
      entry.connecting = null;
      if (!settled) { settled = true; reject(err); }
    });

    const cfg = authConfig(server);
    // ssh2 >= 1.15: hostVerifier(hostKey: Buffer, callback(permitted)) — callback or sync return both work
    cfg.hostVerifier = (hostKey, cb) => {
      const fp = sha256Fingerprint(hostKey);
      conn._fingerprint = fp;
      const row = db.prepare('SELECT fingerprint FROM servers WHERE id = ?').get(server.id);
      if (!row || !row.fingerprint) {
        db.prepare('UPDATE servers SET fingerprint = ? WHERE id = ?').run(fp, server.id);
        server.fingerprint = fp;
        conn._newFingerprint = true;
        cb(true);
        return;
      }
      if (row.fingerprint === fp) { cb(true); return; }
      entry.status.lastError = `host key mismatch: ${fp}`;
      cb(false);
    };

    conn.connect(cfg);
  });

  return entry.connecting;
}

export async function exec(server, cmd, timeout = 12000) {
  const conn = await connect(server);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`exec timeout: ${cmd.slice(0, 60)}`)), timeout);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let stdout = '', stderr = '', code = 0;
      stream.on('data', d => { stdout += d.toString(); });
      stream.stderr.on('data', d => { stderr += d.toString(); });
      stream.on('exit', c => { code = c; });
      stream.on('close', () => {
        clearTimeout(timer);
        entryTouch(server.id, Date.now());
        resolve({ code, stdout, stderr });
      });
    });
  });
}

function entryTouch(serverId, ts) {
  const e = pool.get(serverId);
  if (e && e.status.state === 'online') { e.status.lastCheck = ts; e.status.failCount = 0; }
}

export async function execQuiet(server, cmd, timeout) {
  try { return await exec(server, cmd, timeout); } catch (e) { return { code: -1, stdout: '', stderr: String(e.message || e) }; }
}

// background status heartbeat
let loopStarted = false;
export function startStatusLoop() {
  if (loopStarted) return;
  loopStarted = true;
  const tick = async () => {
    const interval = getSettings().heartbeatInterval * 1000;
    const servers = db.prepare('SELECT * FROM servers').all();
    for (const server of servers) {
      const entry = initEntry(server.id);
      const started = Date.now();
      try {
        await exec(server, 'true', 9000);
        entry.status = { state: 'online', latency: Date.now() - started, failCount: 0, lastCheck: Date.now(), lastError: null };
      } catch (err) {
        entry.status.failCount = (entry.status.failCount || 0) + 1;
        entry.status.lastCheck = Date.now();
        entry.status.lastError = String(err.message || err);
        entry.status.latency = null;
        entry.status.state = entry.status.failCount >= getSettings().heartbeatFails ? 'offline' : 'reconnecting';
      }
    }
    setTimeout(tick, interval).unref();
  };
  setTimeout(tick, 500).unref();
}

export function closeAll() {
  for (const [, e] of pool) { try { e.conn?.end(); } catch { /* noop */ } }
}
