import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import { api } from '../api';
import { toast, nav, useHashRoute } from '../App';
import type { Group, ServerRow, TmuxSession, Settings, ServerStats, LiveStatus } from '../types';
import { ansiToHtml } from '../ansi';
import { confirmDialog } from './Dialog';
import SessionAdmin from './SessionAdmin';
import { IconFolder, IconPlug, IconUser } from '../icons';
import { usePolling, keepRef } from '../usePolling';

export function fmtSize(b: number): string {
  if (!b) return '—';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}

export function fmtUptime(s: number): string {
  if (!s) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

function ResRow({ label, pct, text }: { label: string; pct: number; text: string }) {
  const cls = pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : '';
  return (
    <div className="res-row">
      <span className="res-label">{label}</span>
      <div className={`res-bar ${cls}`}><i style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} /></div>
      <span className="mono res-text">{text}</span>
    </div>
  );
}

export function relTime(ts: number | null): string {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.max(1, Math.floor(d / 1000))} 秒前`;
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  return `${Math.floor(d / 86400_000)} 天前`;
}

export function tagHue(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('codex')) return '#c084fc';
  if (n.includes('codebuddy') || n.includes('cb')) return '#60a5fa';
  if (n.includes('opencode')) return '#2dd4bf';
  if (n.includes('shell') || n.includes('bash') || n.includes('zsh')) return '#fbbf24';
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h}, 52%, 64%)`;
}

// 从会话名与路径推导语义标签（纯展示层）
function sessionTags(s: TmuxSession): string[] {
  const n = s.name.toLowerCase();
  const out: string[] = [];
  if (n.includes('codex')) out.push('#codex');
  else if (n.includes('codebuddy') || /(^|[^a-z])cb([^a-z]|$)/.test(n)) out.push('#codebuddy');
  else if (n.includes('opencode')) out.push('#opencode');
  const base = (s.path || '').split('/').filter(Boolean).pop();
  if (base && base.length <= 16 && !n.includes(base.toLowerCase())) out.push(base);
  return out.slice(0, 2);
}

export interface CtxItem { label: string; danger?: boolean; disabled?: boolean; fn: () => void; }
export interface CtxState { x: number; y: number; items: CtxItem[]; }

/**
 * tmux 会话按 socket 隔离：`/tmp/tmux-0/default` 是每个用户的默认 socket，
 * 别的用户或 `tmux -L <name>` 建的会话在其它 socket 上，**同名会话可能并存**。
 * 所以凡是带上会话的操作（预览 / 窗口 / 终止 / attach）都必须一起带上 socket。
 */
export function sockQS(s: { socket?: string | null }): string {
  return s.socket ? `&socket=${encodeURIComponent(s.socket)}` : '';
}

/** 非默认 socket 的归属标签（优先用户名，取不到退回父目录名）；默认 socket 返回 null */
export function sockTag(s: TmuxSession): string | null {
  if (!s.socket) return null;
  if (s.socketOwner && s.socketOwner !== '?') return s.socketOwner;
  const parts = s.socket.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : s.socket;
}

/**
 * 「当前以哪个用户连接这台机器」的展示文案。
 * 优先用 ssh 连上后实际抓到的身份（`id -un`），退回配置里的 username。
 */
export function connUser(s: { username?: string; host?: string; port?: number; live?: LiveStatus }): string {
  const u = s.live?.ident?.user || s.username || '?';
  if (!s.host) return u;
  return `${u}@${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ''}`;
}

/** 该连接能看到的 tmux 会话范围 —— 由远端 uid 决定，用来解释「为什么有些会话看不到」 */
export function connScope(live?: LiveStatus): string | null {
  const id = live?.ident;
  if (!id) return null;
  return id.uid === 0
    ? `以 ${id.user}（uid 0）连接 —— 可见全部用户的 tmux 会话`
    : `以 ${id.user}（uid ${id.uid}）连接 —— 仅可见该用户自己的 tmux 会话（/tmp/tmux-${id.uid}/）`;
}

/** 菜单与视口边缘至少保留的间距 */
const MENU_MARGIN = 8;

export function ContextMenu({ st, onClose }: { st: CtxState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // 只有「没被应用接管的右键」才关菜单 —— 所有自定义菜单的触发点都会 preventDefault，
    // 而 React 的委托在 #root 上、比 window 更早执行，不判这个的话
    // 「菜单开着时右键另一个位置」会先 setCtx(新) 再被这里 setCtx(null)，菜单直接闪没。
    const onCtx = (e: MouseEvent) => { if (!e.defaultPrevented) onClose(); };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', onCtx);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', onCtx);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 按**实测尺寸**定位：原先写死 `top: min(y, innerHeight - 220)` 是按「菜单不超过 220px」猜的，
  // 会话卡片菜单项一多就超过这个高度，于是菜单会顶出视口底边、「终止会话」被裁掉。
  // 现在：右/下放不下就翻到另一侧；两侧都不够才贴边，并由 max-height 兜住（菜单内部滚动）。
  // 用 useLayoutEffect 是为了在浏览器绘制前完成校正，不会看到菜单先出现在错误位置再跳一下。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = st.x;
    if (left + width > vw - MENU_MARGIN) left = st.x - width;      // 向右放不下 → 翻到左侧
    if (left + width > vw - MENU_MARGIN) left = vw - MENU_MARGIN - width; // 仍不够 → 贴右缘
    if (left < MENU_MARGIN) left = MENU_MARGIN;

    let top = st.y;
    if (top + height > vh - MENU_MARGIN) top = st.y - height;      // 向下放不下 → 翻到上方
    if (top + height > vh - MENU_MARGIN) top = vh - MENU_MARGIN - height; // 仍不够 → 贴底边
    if (top < MENU_MARGIN) top = MENU_MARGIN;                      // 菜单比视口还高 → 贴顶，靠 max-height 滚动

    setPos(prev => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [st]);

  return (
    <div
      ref={ref}
      className="ctxmenu"
      role="menu"
      style={{
        left: pos ? pos.left : st.x,
        top: pos ? pos.top : st.y,
        // 未测量前先不显示，避免在错误位置闪一帧
        visibility: pos ? 'visible' : 'hidden',
        maxHeight: `calc(100vh - ${MENU_MARGIN * 2}px)`,
      }}
    >
      {st.items.map((it, i) => (
        <div key={i}>
          {i > 0 && it.danger && !st.items[i - 1].danger && <div className="sep" />}
          <button
            className={it.danger ? 'danger' : ''}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => { onClose(); it.fn(); }}
          >{it.label}</button>
        </div>
      ))}
    </div>
  );
}

const PreviewCard = memo(function PreviewCard({ serverId, name, socket, interval }: { serverId: number; name: string; socket?: string | null; interval: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [html, setHtml] = useState('<span style="color:var(--dim)">连接中…</span>');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ob = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.05 });
    ob.observe(el);
    return () => ob.disconnect();
  }, []);

  // 自己按 previewInterval 轮询（原先靠外层每 3s 变一次的 tick 驱动）。
  // 好处：① 每张卡各自独立，不再需要把 tick 灌给整个会话网格；
  // ② 顺带拿到「页面隐藏就停」的门控；③ 滚出视口（visible=false）时不发请求。
  usePolling(alive => {
    if (!visible) return;
    void api.preview(serverId, name, socket).then(r => {
      if (!alive()) return; // 卡片滚出视口 / 会话换名后，旧响应不能覆盖新状态
      setHtml(r.text ? ansiToHtml(r.text) : '<span style="color:var(--dim)">（无输出）</span>');
    }).catch(() => { if (alive()) setHtml('<span style="color:var(--red)">预览拉取失败</span>'); });
  }, interval * 1000, [visible, serverId, name, socket, interval]);

  return (
    <div ref={ref} className="sess-preview">
      <div className="prev-bar">
        <span className="pb-l"><i />{name} · 末 8 行</span>
        <span className="pb-cmd">capture-pane -t {name}:0</span>
      </div>
      <div className="prev-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});

/**
 * 会话卡。用 `memo` + 自定义比较挡住两类无意义重渲染（2026-09-30 性能修复）：
 * ① 每 3s 一次的预览刷新 —— 现在改由 PreviewCard 自己轮询，不再往整张网格灌 tick；
 * ② 每 5s 一次 `reload()` —— 配合 `keepRef` 保证数据没变时 `groups` 引用不变，
 *    于是 `filtered` 的 useMemo 不重算、`g` 引用稳定。
 *
 * 比较里**刻意不比函数 props**（onOpen/onDetail/onMenu 每次渲染都是新箭头函数）：
 * 它们只闭包捕获 `s`/`g`，`s`/`g` 不变则行为等价 —— 比函数引用等于把 memo 废掉。
 */
const SessionCard = memo(function SessionCard({ s, g, settings, onOpen, onDetail, onMenu }: {
  s: TmuxSession; g: Group; settings: Settings;
  onOpen: (mode: 'attach' | 'readonly' | 'exclusive') => void;
  onDetail: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const active = s.lastActivity ? Date.now() - s.lastActivity < 5 * 60_000 : false;
  const tags = sessionTags(s);
  const owner = sockTag(s);
  const kill = async () => {
    const ok = await confirmDialog({
      title: `终止会话 ${s.name}`,
      message: `目标机上该会话内的所有进程将被关闭，滚动历史不再保留。\n此操作不可撤销。`
        + (s.socket ? `\n\n注意：该会话不在默认 socket 上（${s.socket}），可能属于其它用户或工具。` : ''),
      danger: true, okLabel: '终止会话'
    });
    if (!ok) return;
    try { await api.killSession(g.serverId, s.name, s.socket); toast(`会话 ${s.name} 已终止`); } catch (e: any) { toast(e.message, true); }
  };
  return (
    <div className={`sess-card ${active ? 'pinned' : ''}`} onClick={e => { if ((e.target as HTMLElement).closest('button')) return; onDetail(); }}>
      <div className="sess-head">
        <div className="sess-id">
          <div className="sess-titlerow">
            <span style={{ color: tagHue(s.name) }}>▍</span>
            <span className="sess-title">{s.name}</span>
            {s.attached > 0 && (
              <span className="sess-pin" title={`${s.attached} 个客户端正在连接`}><IconPlug size={12} /></span>
            )}
          </div>
          <div className="sess-tags">
            <span className="tag srvtag">{g.serverName}</span>
            {owner && <span className="tag socktag" title={`非默认 tmux socket：${s.socket}`}>socket · {owner}</span>}
            {tags.map(t => <span key={t} className="tag tint">{t}</span>)}
          </div>
        </div>
        <span className={`sbadge ${active ? 'live' : ''}`}>
          <i />{active ? '活跃' : '空闲'}<em>{relTime(s.lastActivity)}</em>
        </span>
      </div>

      <div className="sess-meta sess-metabox">
        <span className="mi"><IconFolder size={11} />{s.path || '~'}</span>
        <span>·</span><span>{s.windows} 窗口</span>
        <span>·</span>
        <span style={s.attached > 0 ? { color: 'var(--accent)' } : undefined}>
          {s.attached > 0 ? `${s.attached} 客户端连接` : '无客户端'}
        </span>
      </div>

      <PreviewCard serverId={g.serverId} name={s.name} socket={s.socket} interval={settings.previewInterval} />

      <div className="sess-foot">
        <button className="btn sm primary" onClick={() => onOpen('attach')}>进入工作区</button>
        <button className="btn sm" onClick={() => onOpen('readonly')}>只读</button>
        <button className="btn sm" onClick={() => onOpen('exclusive')}>独占</button>
        <span className="spacer" />
        <button className="btn sm ghost" title="更多操作" onClick={e => { e.stopPropagation(); onMenu(e.clientX, e.clientY); }}>⋯</button>
      </div>
    </div>
  );
}, (a, b) => a.s === b.s && a.g === b.g && a.settings === b.settings);

function NewSessionModal({ servers, onClose, onCreated }: { servers: ServerRow[]; onClose: () => void; onCreated: (serverId: number, name: string) => void }) {
  const online = servers.filter(s => s.live.state === 'online');
  const [serverId, setServerId] = useState(online[0]?.id ?? 0);
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name);
  return (
    <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-h">新建会话</div>
        <div className="modal-b">
          <div className="field">
            <label>目标服务器（仅在线）</label>
            <select value={serverId} onChange={e => setServerId(Number(e.target.value))}>
              {online.map(s => <option key={s.id} value={s.id}>{s.name} · {s.host}</option>)}
            </select>
          </div>
          <div className="field">
            <label>会话名</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="如 codex-projA" autoFocus />
            {name && !ok && <div className="hint" style={{ color: 'var(--red)' }}>字母/数字开头，可含 . _ -</div>}
          </div>
          <div className="field">
            <label>起始目录（可选）</label>
            <input value={dir} onChange={e => setDir(e.target.value)} placeholder="~/projects/projA" />
          </div>
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!ok || !serverId || busy} onClick={async () => {
            setBusy(true);
            try { await api.createSession(serverId, name, dir || undefined); toast(`会话 ${name} 已创建`); onCreated(serverId, name); }
            catch (e: any) { toast(e.message, true); }
            finally { setBusy(false); }
          }}>创建并进入</button>
        </div>
      </div>
    </div>
  );
}

export default function Overview() {
  const { params } = useHashRoute();
  const [groups, setGroups] = useState<Group[]>([]);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'group' | 'list'>('group');
  const [ctx, setCtx] = useState<CtxState | null>(null);
  /** 会话管理面板的目标（重命名 / 参数 / 窗口 / 终止） */
  const [admin, setAdmin] = useState<{ g: Group; s: TmuxSession } | null>(null);
  const [newSess, setNewSess] = useState(false);
  const [detail, setDetail] = useState<{ s: TmuxSession; g: Group; windows: { index: number; name: string }[]; stats: ServerStats | null; latency: number | null } | null>(null);

  const reload = useCallback(async () => {
    try {
      const [r, sr] = await Promise.all([api.sessions(), api.servers()]);
      // keepRef：数据没变就保持旧引用。少了这一步，每 5s 一次新的 groups 数组会让
      // 下方 SessionCard 的 memo 全部失效、`filtered` 的 useMemo 全部重算。
      setGroups(prev => keepRef(prev, r.groups));
      setServers(prev => keepRef(prev, sr.servers));
    } catch { /* noop */ }
  }, []);

  useEffect(() => { api.settings().then(setSettings).catch(() => {}); }, []);
  // 注：reload 也被「新建/终止会话」等操作直接调用，所以不在它内部做 alive 判断，
  // 保持「谁都能随时调」的语义（数据本身幂等，早晚会被下一次轮询覆盖）。
  usePolling(() => { void reload(); }, 5000, [reload]);

  // Esc closes menus / drawer / modal
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setCtx(null);
      setDetail(null);
      setNewSess(false);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // 注：原先这里有一个 `setInterval(() => setTick(x => x + 1), previewInterval)`，
  // 每 3s 变一次 state 来驱动所有预览卡刷新 —— 代价是**整个会话网格每 3s 全量重渲染**。
  // 现在每张 PreviewCard 自己用 usePolling 按 interval 拉数据，这个全局 tick 已删除。

  // 节点筛选来自 URL —— 由左侧 rail 的 HOST NODES 点击驱动，页面内不再重复放节点菜单
  const srvRaw = params.get('server');
  const srvNum = Number(srvRaw);
  const srvFilter = srvRaw && Number.isFinite(srvNum) ? srvNum : null;
  const srvFilterName = srvFilter != null
    ? (servers.find(x => x.id === srvFilter)?.name ?? `#${srvFilter}`)
    : null;
  const srvFilterState = srvFilter != null
    ? (groups.find(g => g.serverId === srvFilter)?.live.state ?? 'offline')
    : 'offline';

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => groups.map(g => ({
    ...g,
    sessions: g.sessions.filter(s =>
      (srvFilter == null || g.serverId === srvFilter) &&
      (!q || s.name.toLowerCase().includes(q) || g.serverName.toLowerCase().includes(q))
    )
  })), [groups, q, srvFilter]);

  const openSession = (g: Group, s: TmuxSession, mode: 'attach' | 'readonly' | 'exclusive') =>
    nav(`/terminal?server=${g.serverId}&session=${encodeURIComponent(s.name)}&mode=${mode}${sockQS(s)}`);

  // 同名会话可能存在于不同 socket，抽屉的「当前会话」判定要连 socket 一起比
  const sameSess = (d: { s: TmuxSession } | null, s: TmuxSession) =>
    !!d && d.s.name === s.name && (d.s.socket || null) === (s.socket || null);

  const openDetail = async (g: Group, s: TmuxSession) => {
    setDetail({ s, g, windows: [], stats: null, latency: g.live.latency });
    try {
      const r = await api.windows(g.serverId, s.name, s.socket);
      setDetail(d => (sameSess(d, s) ? { ...d!, windows: r.windows } : d));
    } catch { /* noop */ }
  };

  // 抽屉打开期间轮询服务器资源与窗口
  const detailSrv = detail?.g.serverId, detailSess = detail?.s.name;
  usePolling(alive => {
    if (!detailSrv || !detailSess) return;
    void api.serverStats(detailSrv).then(st => {
      if (!alive()) return;
      setDetail(d => (d && d.s.name === detailSess ? { ...d, stats: st.stats, latency: st.latency } : d));
    }).catch(() => { /* noop */ });
  }, 5000, [detailSrv, detailSess]);

  // 概览统计（由已加载数据推导）
  const totalSessions = groups.reduce((n, g) => n + g.sessions.length, 0);
  const activeSessions = groups.reduce((n, g) => n + g.sessions.filter(s => s.lastActivity && Date.now() - s.lastActivity < 5 * 60_000).length, 0);
  const onlineServers = servers.filter(s => s.live.state === 'online').length;

  return (
    <div className="content content-wide">
      <div className="ov-head">
        <h2>会话总览</h2>
        {srvFilter != null && (
          <span className="srv-chip" title="当前仅显示该节点的会话（点击左侧节点可切换）">
            <span className={`dot ${srvFilterState}`} />
            {srvFilterName}
            <button onClick={() => nav('/sessions')} title="清除节点筛选">×</button>
          </span>
        )}
        <input className="ov-search" placeholder="快速检索会话名称、路径、所在服务器…" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="seg hide-mobile">
          <button className={viewMode === 'group' ? 'on' : ''} onClick={() => setViewMode('group')}>按服务器</button>
          <button className={viewMode === 'list' ? 'on' : ''} onClick={() => setViewMode('list')}>全部列表</button>
        </div>
        <button className="btn sm" title="立即刷新" onClick={reload}>刷新</button>
        <button className="btn primary sm" onClick={() => setNewSess(true)}>+ 新建会话</button>
      </div>

      <p className="page-sub">
        {servers.length} 台节点 · {totalSessions} 个运行中会话（{activeSessions} 个 5 分钟内活跃）· 终端预览每 {settings?.previewInterval ?? 3} 秒刷新
      </p>

      <div className="stat-row">
        <div className="stat">
          <span className="st-l">运行中会话</span>
          <span className="st-v">{totalSessions}</span>
          <span className="st-s">跨 {groups.filter(g => g.sessions.length > 0).length} 台服务器</span>
        </div>
        <div className={`stat ${activeSessions > 0 ? 'ok' : ''}`}>
          <span className="st-l">活跃会话</span>
          <span className="st-v">{activeSessions}</span>
          <span className="st-s">5 分钟内有输出</span>
        </div>
        <div className={`stat ${servers.length > 0 && onlineServers === servers.length ? 'ok' : servers.length === 0 ? '' : 'warn'}`}>
          <span className="st-l">集群节点</span>
          <span className="st-v">{onlineServers}/{servers.length}</span>
          <span className="st-s">{servers.length > 0 && onlineServers === servers.length ? '全部在线' : '存在异常节点'}</span>
        </div>
      </div>

      <div className="ov-layout">
        <section>
          {filtered.every(g => g.sessions.length === 0) && (
            <div className="empty"><div className="big">▢</div>没有运行中的 tmux 会话<br />点右上角「+ 新建会话」开始</div>
          )}
          {viewMode === 'group' ? filtered.map(g => g.sessions.length > 0 && (
            <div key={g.serverId}>
              <div className="group-h">
                <span className={`dot ${g.live.state}`} /> {g.serverName}
                {/* 当前连接所用的用户（ssh 连上后抓到的实际身份，退回配置值） */}
                <span className="conn-user" title={connScope(g.live) || '尚未获取远端身份'}>
                  <IconUser size={10} />{connUser(g)}
                </span>
                {g.live.latency != null && <span style={{ color: 'var(--dim)' }}>{g.live.latency}ms</span>}
                <span style={{ color: g.live.state === 'online' ? 'var(--accent)' : g.live.state === 'reconnecting' ? 'var(--amber)' : 'var(--dim)' }}>
                  {g.live.state === 'online' ? '在线' : g.live.state === 'reconnecting' ? '重连中' : '离线'}
                </span>
              </div>
              <div className="sess-grid">
                {g.sessions.map(s => (
                  <SessionCard key={`${s.socket || 'default'}:${s.name}`} s={s} g={g} settings={settings!}
                    onOpen={m => openSession(g, s, m)}
                    onDetail={() => openDetail(g, s)}
                    onMenu={(x, y) => setCtx({
                      x, y, items: [
                        { label: '进入', fn: () => openSession(g, s, 'attach') },
                        { label: '只读', fn: () => openSession(g, s, 'readonly') },
                        { label: '独占', fn: () => openSession(g, s, 'exclusive') },
                        { label: '会话详情', fn: () => openDetail(g, s) },
                        { label: '会话管理…（重命名 / 参数 / 窗口）', fn: () => setAdmin({ g, s }) },
                        { label: '终止会话', danger: true, fn: () => confirmDialog({
                            title: `终止会话 ${s.name}`,
                            message: `目标机上该会话内的所有进程将被关闭，滚动历史不再保留。\n此操作不可撤销。`
                              + (s.socket ? `\n\n注意：该会话不在默认 socket 上（${s.socket}），可能属于其它用户或工具。` : ''),
                            danger: true, okLabel: '终止会话'
                          }).then(ok => { if (ok) api.killSession(g.serverId, s.name, s.socket).then(() => reload()).catch((e: any) => toast(e.message, true)); }) }
                      ]
                    })}
                  />
                ))}
              </div>
            </div>
          )) : null}
          {viewMode === 'list' && (
            <div className="panel" style={{ overflowX: 'auto' }}>
              <table className="tbl">
                <thead><tr>
                  <th>会话</th><th>服务器</th><th>窗口</th><th>客户端</th>
                  <th className="hide-mobile">路径</th><th>最后活动</th><th></th>
                </tr></thead>
                <tbody>
                  {filtered.flatMap(g => g.sessions.map(s => ({ g, s })))
                    .sort((a, b) => (b.s.lastActivity || 0) - (a.s.lastActivity || 0))
                    .map(({ g, s }) => {
                      const active = s.lastActivity ? Date.now() - s.lastActivity < 5 * 60_000 : false;
                      return (
                        <tr key={`${g.serverId}:${s.socket || 'default'}:${s.name}`}>
                          <td>
                            <span style={{ color: tagHue(s.name) }}>▍</span> <span className="mono" style={{ fontWeight: 600 }}>{s.name}</span>
                            {sockTag(s) && <span className="tag socktag" style={{ marginLeft: 6 }} title={`非默认 tmux socket：${s.socket}`}>socket · {sockTag(s)}</span>}
                          </td>
                          <td><span className={`dot ${g.live.state}`} style={{ marginRight: 7 }} />{g.serverName}</td>
                          <td className="mono">{s.windows}</td>
                          <td className="mono">{s.attached > 0 ? s.attached : '—'}</td>
                          <td className="mono hide-mobile">{s.path || '—'}</td>
                          <td className="mono"><span className={active ? 'act-live' : 'act-idle'}>{relTime(s.lastActivity)} · {active ? '活跃' : '空闲'}</span></td>
                          <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                            <button className="btn sm primary" onClick={() => openSession(g, s, 'attach')}>进入</button>
                            <button className="btn sm ghost hide-mobile" onClick={() => openSession(g, s, 'readonly')}>只读</button>
                            <button className="btn sm ghost hide-mobile" onClick={() => openSession(g, s, 'exclusive')}>独占</button>
                            <button className="btn sm ghost" title="重命名 / 参数 / 窗口" onClick={() => setAdmin({ g, s })}>管理</button>
                            <button className="btn sm ghost" style={{ color: 'var(--red)' }} onClick={async () => {
                              const ok = await confirmDialog({
                                title: `终止会话 ${s.name}`,
                                message: `目标机上该会话内的所有进程将被关闭，滚动历史不再保留。\n此操作不可撤销。`
                                  + (s.socket ? `\n\n注意：该会话不在默认 socket 上（${s.socket}），可能属于其它用户或工具。` : ''),
                                danger: true, okLabel: '终止会话'
                              });
                              if (ok) api.killSession(g.serverId, s.name, s.socket).then(() => reload()).catch((e: any) => toast(e.message, true));
                            }}>终止</button>
                          </td>
                        </tr>
                      );
                    })}
                  {filtered.every(g => g.sessions.length === 0) && (
                    <tr><td colSpan={7}><div className="empty">没有匹配的会话</div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {ctx && <ContextMenu st={ctx} onClose={() => setCtx(null)} />}
      {newSess && (
        <NewSessionModal servers={servers} onClose={() => setNewSess(false)}
          onCreated={(sid, name) => { setNewSess(false); reload(); nav(`/terminal?server=${sid}&session=${encodeURIComponent(name)}&mode=attach`); }} />
      )}
      {detail && (
        <>
          <div className="drawer-mask" onClick={() => setDetail(null)} />
          <div className="drawer">
            <button className="drawer-close" onClick={() => setDetail(null)} title="关闭（Esc）">×</button>
            <h3 style={{ margin: '0 0 4px', fontFamily: 'var(--mono)', fontSize: 15 }}>
              <span style={{ color: tagHue(detail.s.name) }}>▍</span>{detail.s.name}
            </h3>
            <div style={{ color: 'var(--dim)', fontSize: 11.5, fontFamily: 'var(--mono)' }}>{detail.g.serverName}</div>
            <dl className="kv">
              <dt>路径</dt><dd>{detail.s.path || '—'}</dd>
              <dt>窗口数</dt><dd>{detail.s.windows}</dd>
              <dt>客户端</dt><dd>{detail.s.attached > 0 ? `${detail.s.attached} 个已连接` : '无'}</dd>
              <dt>创建于</dt><dd>{relTime(detail.s.created)}</dd>
              <dt>最后活动</dt><dd>{relTime(detail.s.lastActivity)}</dd>
              {detail.s.socket && (
                <>
                  <dt>socket</dt>
                  <dd className="mono" style={{ wordBreak: 'break-all' }}>
                    {detail.s.socket}
                    <span className="tag socktag" style={{ marginLeft: 6 }}>{detail.s.socketOwner || '其它'}</span>
                  </dd>
                </>
              )}
            </dl>
            <div style={{ fontSize: 11, color: 'var(--muted)', margin: '14px 0 6px', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '.06em' }}>窗口列表</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {detail.windows.length > 0
                ? detail.windows.map(w => <span key={w.index} className="tag">{w.index}:{w.name}</span>)
                : <span className="tag">加载中…</span>}
            </div>

            <div style={{ fontSize: 11, color: 'var(--muted)', margin: '18px 0 8px', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
              服务器资源
              <span className={`dot ${detail.stats ? 'online' : detail.latency != null ? 'reconnecting' : 'offline'}`} style={{ width: 6, height: 6 }} />
            </div>
            <dl className="kv">
              <dt>网络延迟</dt><dd>{detail.latency != null ? `${detail.latency} ms` : '—'}</dd>
            </dl>
            {detail.stats ? (
              <>
                <ResRow label="CPU" pct={detail.stats.cpuPct} text={`${detail.stats.cpuPct}% · ${detail.stats.cores} 核`} />
                <ResRow label="内存" pct={detail.stats.mem.total ? Math.round(detail.stats.mem.used / detail.stats.mem.total * 100) : 0}
                  text={`${fmtSize(detail.stats.mem.used)} / ${fmtSize(detail.stats.mem.total)}`} />
                <ResRow label="磁盘 /" pct={detail.stats.disk.pct}
                  text={`${fmtSize(detail.stats.disk.used)} / ${fmtSize(detail.stats.disk.total)} · ${detail.stats.disk.pct}%`} />
                <div className="res-row">
                  <span className="res-label">负载</span>
                  <span className="mono res-text" style={{ flex: 1 }}>{detail.stats.load}（{detail.stats.cores} 核）</span>
                </div>
                <div className="res-row">
                  <span className="res-label">运行</span>
                  <span className="mono res-text" style={{ flex: 1 }}>{fmtUptime(detail.stats.uptimeS)}</span>
                </div>
              </>
            ) : (
              <div style={{ color: 'var(--dim)', fontSize: 11.5, margin: '4px 0 8px' }}>
                {detail.latency != null ? '采集中…' : '服务器离线，无资源数据'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 7, marginTop: 22, flexWrap: 'wrap' }}>
              <button className="btn primary sm" onClick={() => { openSession(detail.g, detail.s, 'attach'); setDetail(null); }}>进入</button>
              <button className="btn sm" onClick={() => { openSession(detail.g, detail.s, 'readonly'); setDetail(null); }}>只读</button>
              <button className="btn sm" onClick={() => { openSession(detail.g, detail.s, 'exclusive'); setDetail(null); }}>独占</button>
              <button className="btn sm" onClick={() => setAdmin({ g: detail.g, s: detail.s })}>会话管理…</button>
              <span style={{ flex: 1 }} />
              <button className="btn danger sm" onClick={async () => {
                const ok = await confirmDialog({
                  title: `终止会话 ${detail.s.name}`,
                  message: `目标机上该会话内的所有进程将被关闭，滚动历史不再保留。\n此操作不可撤销。`
                    + (detail.s.socket ? `\n\n注意：该会话不在默认 socket 上（${detail.s.socket}），可能属于其它用户或工具。` : ''),
                  danger: true, okLabel: '终止会话'
                });
                if (ok) api.killSession(detail.g.serverId, detail.s.name, detail.s.socket).then(() => { toast('已终止'); setDetail(null); reload(); }).catch((e: any) => toast(e.message, true));
              }}>终止会话</button>
            </div>
          </div>
        </>
      )}

      {admin && (
        <SessionAdmin
          serverId={admin.g.serverId}
          serverName={admin.g.serverName}
          info={admin.s}
          onClose={() => setAdmin(null)}
          onRenamed={newName => {
            setAdmin(a => (a ? { ...a, s: { ...a.s, name: newName } } : a));
            reload();
          }}
          onKilled={() => { setDetail(null); reload(); }}
          onChanged={reload}
        />
      )}
    </div>
  );
}
