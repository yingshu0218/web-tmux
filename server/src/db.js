import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'tmuxweb.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'key',
  private_key_enc TEXT,
  password_enc TEXT,
  fingerprint TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS op_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
`);

export function logOp(action, detail, ip) {
  db.prepare('INSERT INTO op_logs (at, action, detail, ip) VALUES (?, ?, ?, ?)')
    .run(Date.now(), action, detail || '', ip || '');
}

const DEFAULT_SETTINGS = {
  previewInterval: 3,
  heartbeatInterval: 15,
  heartbeatFails: 3,
  wsPing: 10,
  wsTimeout: 20,
  loginTtlDays: 30,
  totpEnabled: false,
  deleteConfirmLevel: 'graded',
  reconnectMax: 3,
  quickCommands: ['npm run dev', 'npm test', 'git status', 'htop', 'df -h'],
  // 终端滚轮：view = 上滚查看输出内容（tmux mouse on，走 copy-mode 历史）
  //            keys = 滚轮调历史输入（tmux mouse off，滚轮被译为 ↑↓ 交给 pane）
  scrollDefault: 'view',
  historyLimit: 10000,
  scrollExitOnInput: true,
  // 服务器级 window-size 策略：latest / largest / smallest / manual。
  // 做成**全局**而不是会话级 —— 实测 tmux 3.3a 在「无客户端连接时」会把会话级的 window-size
  // 重置掉（见 AGENTS.md §5.15），逐个会话设既不稳定又要重复操作。
  windowSize: 'latest'
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try { s[r.key] = JSON.parse(r.value); } catch { s[r.key] = r.value; }
  }
  return s;
}

export function setSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, JSON.stringify(v));
  }
}

// bootstrap admin
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, bcrypt.hashSync(password, 10), Date.now());
  console.log(`[init] admin account created: ${username}`);
}

export function findUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
export function updateUserPassword(userId, hash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
}
export function createSessionToken(userId, ttlDays) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + ttlDays * 86400_000;
  db.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, expires };
}
export function verifySessionToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM auth_sessions WHERE token = ?').get(token);
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}
export function deleteSessionToken(token) {
  db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
}
