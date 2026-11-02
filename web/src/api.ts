export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  // 只有在真的带 body 时才声明 Content-Type: application/json。
  // 无 body 却带上它，Fastify 会直接以 FST_ERR_CTP_EMPTY_JSON_BODY 拒掉（400 Bad Request），
  // 于是「接入检查 / 一键修复 linger / 一键下发配置 / 终止会话 / 删除服务器 / 退出登录」
  // 这些无 body 的 POST、DELETE 会全部失效 —— 甚至在它们之前就已经落库的副作用会留下脏数据。
  const hasBody = opts.body != null;
  const res = await fetch(path, {
    ...opts,
    headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    credentials: 'same-origin'
  });
  if (res.status === 401 && !path.includes('/api/login')) {
    location.hash = '#/login';
    throw new ApiError(401, '未登录');
  }
  const data = await res.json().catch(() => ({}));
  // Fastify 的内置错误体是 { statusCode, code, error, message }，业务错误体是 { error }。
  // 优先取 message，否则用户只会看到一句毫无信息量的「Bad Request」。
  if (!res.ok) throw new ApiError(res.status, (data as any).message || (data as any).error || `HTTP ${res.status}`);
  return data as T;
}

const post = <T,>(path: string, body?: unknown) => req<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
const put = <T,>(path: string, body?: unknown) => req<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T,>(path: string, body?: unknown) => req<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined });
const del = <T,>(path: string) => req<T>(path, { method: 'DELETE' });

/** socket 是会话定位的一部分（同名会话可能在不同 socket 上并存），凡带会话的请求都要一起带上 */
const sockQ = (socket?: string | null) => (socket ? `?socket=${encodeURIComponent(socket)}` : '');

export const api = {
  login: (username: string, password: string) => post<{ ok: boolean; username: string }>('/api/login', { username, password }),
  logout: () => post<{ ok: boolean }>('/api/logout'),
  me: () => req<{ username: string; totpEnabled: boolean }>('/api/me'),
  changePassword: (oldPassword: string, newPassword: string) => post<{ ok: boolean }>('/api/me/password', { oldPassword, newPassword }),

  servers: () => req<{ servers: import('./types').ServerRow[] }>('/api/servers'),
  addServer: (b: { name: string; host: string; port: number; username: string; auth_type: string; privateKey?: string; password?: string }) => post<{ id: number }>('/api/servers', b),
  updateServer: (id: number, b: Record<string, unknown>) => put<{ ok: boolean }>(`/api/servers/${id}`, b),
  deleteServer: (id: number) => del<{ ok: boolean }>(`/api/servers/${id}`),
  checkServer: (id: number) => post<{ items: import('./types').CheckItem[]; passed: boolean }>(`/api/servers/${id}/check`),
  tmuxVersion: (id: number) => req<{ ok: boolean; version: string | null; path: string | null }>(`/api/servers/${id}/tmux-version`),
  serverStats: (id: number) => req<{ state: string; latency: number | null; stats: import('./types').ServerStats | null; error?: string }>(`/api/servers/${id}/stats`),
  fixLinger: (id: number) => post<{ ok: boolean; output: string }>(`/api/servers/${id}/fix-linger`),
  pushConf: (id: number) => post<{ ok: boolean; path: string }>(`/api/servers/${id}/push-tmux-conf`),

  sessions: () => req<{ groups: import('./types').Group[] }>('/api/sessions'),
  preview: (serverId: number, session: string, socket?: string | null) =>
    req<{ text: string; activity: number | null }>(`/api/sessions/preview?serverId=${serverId}&session=${encodeURIComponent(session)}${socket ? `&socket=${encodeURIComponent(socket)}` : ''}`),
  windows: (serverId: number, session: string, socket?: string | null) =>
    req<{ windows: import('./types').TmuxWindow[] }>(`/api/servers/${serverId}/windows?session=${encodeURIComponent(session)}${socket ? `&socket=${encodeURIComponent(socket)}` : ''}`),
  createSession: (serverId: number, name: string, dir?: string) => post<{ ok: boolean }>(`/api/servers/${serverId}/sessions`, { name, dir }),
  killSession: (serverId: number, name: string, socket?: string | null) =>
    del<{ ok: boolean }>(`/api/servers/${serverId}/sessions/${encodeURIComponent(name)}${socket ? `?socket=${encodeURIComponent(socket)}` : ''}`),
  setScroll: (serverId: number, session: string, mode: 'view' | 'keys', socket?: string | null) =>
    post<{ ok: boolean; mouse: string; mode: string }>(`/api/servers/${serverId}/scroll`, { session, mode, socket: socket || undefined }),

  // ---- 会话管理：重命名 / 会话级参数 / 窗口 ----
  renameSession: (serverId: number, name: string, newName: string, socket?: string | null) =>
    patch<{ ok: boolean; name: string; unchanged?: boolean }>(
      `/api/servers/${serverId}/sessions/${encodeURIComponent(name)}${sockQ(socket)}`, { name: newName }),
  sessionOptions: (serverId: number, name: string, socket?: string | null) =>
    req<{ options: import('./types').SessionOptions }>(
      `/api/servers/${serverId}/sessions/${encodeURIComponent(name)}/options${sockQ(socket)}`),
  saveSessionOptions: (serverId: number, name: string, body: Record<string, unknown>, socket?: string | null) =>
    put<{ ok: boolean; options: import('./types').SessionOptions }>(
      `/api/servers/${serverId}/sessions/${encodeURIComponent(name)}/options${sockQ(socket)}`, body),
  createWindow: (serverId: number, session: string, name: string, socket?: string | null) =>
    post<{ ok: boolean; windows: import('./types').TmuxWindow[] }>(
      `/api/servers/${serverId}/sessions/${encodeURIComponent(session)}/windows${sockQ(socket)}`, { name }),
  renameWindow: (serverId: number, session: string, index: number, name: string, socket?: string | null) =>
    patch<{ ok: boolean; windows: import('./types').TmuxWindow[] }>(
      `/api/servers/${serverId}/sessions/${encodeURIComponent(session)}/windows/${index}${sockQ(socket)}`, { name }),
  killWindow: (serverId: number, session: string, index: number, socket?: string | null) =>
    del<{ ok: boolean; lastWindow: boolean; killed: { index: number; name: string }; windows: import('./types').TmuxWindow[] }>(
      `/api/servers/${serverId}/sessions/${encodeURIComponent(session)}/windows/${index}${sockQ(socket)}`),
  /** 切换当前窗口（会话级：所有连接的客户端都会跟着切） */
  selectWindow: (serverId: number, session: string, index: number, socket?: string | null) =>
    post<{ ok: boolean; index: number; windows: import('./types').TmuxWindow[] }>(
      `/api/servers/${serverId}/sessions/${encodeURIComponent(session)}/windows/${index}/select${sockQ(socket)}`),

  settings: () => req<import('./types').Settings>('/api/settings'),
  saveSettings: (p: Partial<import('./types').Settings>) => put<import('./types').Settings>('/api/settings', p),
  logs: (limit = 100) => req<{ logs: import('./types').OpLog[] }>(`/api/logs?limit=${limit}`)
};
