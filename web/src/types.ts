/** 远端实际登录身份（连接就绪时抓一次；与配置里的 username 可能不同） */
export interface RemoteIdent {
  user: string;
  uid: number | null;
}

export interface LiveStatus {
  state: 'online' | 'reconnecting' | 'offline';
  latency: number | null;
  failCount: number;
  lastCheck: number | null;
  lastError: string | null;
  /** ssh 连上后 `id -un` / `id -u` 的结果；null = 尚未抓到 */
  ident?: RemoteIdent | null;
}

export interface ServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: 'key' | 'password';
  fingerprint: string | null;
  created_at: number;
  live: LiveStatus;
}

export interface TmuxSession {
  name: string;
  windows: number;
  attached: number;
  created: number | null;
  lastActivity: number | null;
  path: string;
  /** 会话级显式 mouse 值：'on' | 'off' | null（null = 未显式设置，继承全局） */
  mouse?: 'on' | 'off' | null;
  /** 该会话是否正处于 copy-mode（tmux 历史浏览模式，键盘被吞） */
  inMode?: boolean;
  /** 非默认 tmux socket 的绝对路径；null/undefined = 默认 socket（本管理台自己用的那套） */
  socket?: string | null;
  /** 该 socket 的归属用户名（仅非默认 socket 有意义） */
  socketOwner?: string;
}

/** 服务器上的一个 tmux socket（会话按 socket 隔离） */
export interface TmuxSocket {
  socket: string | null;
  owner: string;
  sessions: number;
}

/** 会话里的一个 tmux 窗口 */
export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
}

/**
 * 单个会话级选项的取值。
 * tmux 未显式设置时会话级为空（继承全局），所以 `explicit=false` 表示「跟随全局」，
 * 此时 `value` 填的是全局值，`global` 单独保留供 UI 展示「继承自全局 X」。
 */
export interface SessionOptionValue {
  value: string | null;
  explicit: boolean;
  global: string | null;
}

/** 会话级可调参数（白名单由后端 server/src/tmux.js 的 SESSION_OPT_SPEC 决定） */
export interface SessionOptions {
  historyLimit: SessionOptionValue;
  windowSize: SessionOptionValue;
  destroyUnattached: SessionOptionValue;
  mouse: SessionOptionValue;
}

export interface Group {
  serverId: number;
  serverName: string;
  host?: string;
  port?: number;
  username?: string;
  live: LiveStatus;
  sessions: TmuxSession[];
  /** 探测到的所有 socket；含默认 socket（socket=null） */
  sockets?: TmuxSocket[];
}

export interface Settings {
  previewInterval: number;
  heartbeatInterval: number;
  heartbeatFails: number;
  wsPing: number;
  wsTimeout: number;
  loginTtlDays: number;
  totpEnabled: boolean;
  deleteConfirmLevel: 'graded' | 'always' | 'never';
  reconnectMax: number;
  quickCommands: string[];
  /** 滚轮默认行为：view=上滚查看输出内容（tmux mouse on） / keys=滚轮调历史输入（mouse off） */
  scrollDefault: 'view' | 'keys';
  /** tmux 历史缓冲行数（仅对新建窗格生效） */
  historyLimit: number;
  /** 历史模式下首次键盘输入自动退出 copy-mode（只在历史模式下有效） */
  scrollExitOnInput: boolean;
  /**
   * 服务器级窗口尺寸策略（latest / largest / smallest / manual）。
   * 管理台是浏览器客户端，尺寸与真实终端必然不同：默认的 latest 会把浏览器尺寸推给 tmux，
   * 可能挤到别人正在用的画面；只想旁观时选 largest 或 manual。
   */
  windowSize: 'latest' | 'largest' | 'smallest' | 'manual';
}

export interface CheckItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string | null;
  warnOnly?: boolean;
}

export interface OpLog { id: number; at: number; action: string; detail: string; ip: string; }

export interface ServerStats {
  cpuPct: number;
  load: string;
  cores: number;
  uptimeS: number;
  mem: { total: number; used: number; avail: number };
  disk: { total: number; used: number; pct: number };
}

export interface OpenTab {
  key: string;
  /**
   * React 渲染用的稳定标识，创建后**永不改变**。
   * 刻意与 key 分开：会话一旦被重命名，key 里的会话名会跟着变，
   * 若直接拿 key 当 React key，改名会触发 TermPane 重挂载 → WebSocket 断开、浏览器侧 scrollback 丢失。
   */
  uid: string;
  serverId: number;
  serverName: string;
  session: string | null; // null = temp shell
  mode: 'attach' | 'readonly' | 'exclusive' | 'shell';
  /** 非默认 tmux socket（别的用户 / tmux -L 命名 socket） */
  socket?: string | null;
}
