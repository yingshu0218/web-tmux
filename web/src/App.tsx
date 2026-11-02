import { useEffect, useState, useCallback, useMemo, useRef, Fragment, lazy, Suspense } from 'react';
import { api } from './api';
import type { Group, ServerRow } from './types';
import Login from './views/Login';
import Overview, { connUser, connScope } from './views/Overview';
import Servers from './views/Servers';
import Settings from './views/Settings';
import { DialogHost } from './views/Dialog';
import { IconGrid, IconTerminal, IconServer, IconSliders, IconSearch } from './icons';
import { usePolling, keepRef } from './usePolling';

// 终端工作区依赖 xterm，体积约占首屏 JS 的一半，而它只在进入 #/terminal 时才需要 —— 改成按需加载。
// 这样首屏（登录页 / 会话总览）不会为空着的 xterm 付费。
const Terminal = lazy(() => import('./views/Terminal'));

// ---- tiny toast bus ----
type Toast = { id: number; msg: string; err?: boolean };
let toastId = 1;
const listeners = new Set<(t: Toast) => void>();
export function toast(msg: string, err = false) {
  const t = { id: toastId++, msg, err };
  listeners.forEach(l => l(t));
}

export function useHashRoute() {
  const [hash, setHash] = useState(location.hash || '#/sessions');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/sessions');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const [path, query] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query || '');
  return { path: path || '/sessions', params };
}

export function nav(path: string) { location.hash = path; }

export const NAV = [
  { path: '/sessions', label: '会话总览', Icon: IconGrid },
  { path: '/terminal', label: '终端工作区', Icon: IconTerminal },
  { path: '/servers', label: '服务器管理', Icon: IconServer },
  { path: '/settings', label: '系统设置', Icon: IconSliders }
];

// ============================================================ Quick Search
type CmdItem = { key: string; group: string; label: string; sub?: string; run: () => void };

function QuickSearch({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    Promise.all([
      api.sessions().catch(() => ({ groups: [] as Group[] })),
      api.servers().catch(() => ({ servers: [] as ServerRow[] }))
    ]).then(([a, b]) => { setGroups(a.groups); setServers(b.servers); });
  }, []);

  const items = useMemo<CmdItem[]>(() => {
    const ql = q.trim().toLowerCase();
    const out: CmdItem[] = [];
    NAV.forEach(n => out.push({
      key: 'nav:' + n.path, group: '页面', label: n.label, sub: n.path,
      run: () => { nav(n.path); onClose(); }
    }));
    groups.forEach(g => g.sessions.forEach(s => {
      // 非默认 socket 上的会话（别的用户 / tmux -L）要带上 socket 才能正确定位
      const sockQS = s.socket ? `&socket=${encodeURIComponent(s.socket)}` : '';
      const owner = s.socket ? (s.socketOwner && s.socketOwner !== '?' ? s.socketOwner : s.socket) : '';
      out.push({
        key: `sess:${g.serverId}:${s.socket || 'default'}:${s.name}`, group: '会话', label: s.name,
        sub: `${g.serverName} · ${s.windows} 窗口${owner ? ` · socket ${owner}` : ''}`,
        run: () => { nav(`/terminal?server=${g.serverId}&session=${encodeURIComponent(s.name)}&mode=attach${sockQS}`); onClose(); }
      });
    }));
    servers.forEach(s => out.push({
      key: 'srv:' + s.id, group: '服务器', label: s.name,
      sub: `${connUser(s)}${s.live.latency != null ? ` · ${s.live.latency}ms` : ''}${s.live.ident?.uid === 0 ? ' · root' : ''}`,
      run: () => { nav(`/terminal?server=${s.id}&mode=shell`); onClose(); }
    }));
    const hit = ql
      ? out.filter(i => i.label.toLowerCase().includes(ql) || (i.sub || '').toLowerCase().includes(ql))
      : out;
    return hit.slice(0, 40);
  }, [q, groups, servers, onClose]);

  useEffect(() => { setIdx(0); }, [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[idx]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let flat = -1;
  return (
    <div className="cmdk-mask" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" onKeyDown={onKey}>
        <div className="cmdk-in">
          <span style={{ color: 'var(--dim)', display: 'grid', placeItems: 'center' }}><IconSearch size={15} /></span>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)}
            placeholder="检索会话、服务器或跳转页面…" />
          <span className="kbd">ESC</span>
        </div>
        <div className="cmdk-body">
          {items.length === 0 && <div className="cmdk-empty">没有匹配结果</div>}
          {items.map(it => {
            flat++;
            const i = flat;
            const head = i === 0 || items[i - 1].group !== it.group;
            return (
              <Fragment key={it.key}>
                {head && <div className="cmdk-group">{it.group}</div>}
                <div
                  ref={el => { if (i === idx && el) el.scrollIntoView({ block: 'nearest' }); }}
                  className={`cmdk-item ${i === idx ? 'on' : ''}`}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => it.run()}>
                  <span className="ci-name">{it.label}</span>
                  {it.sub && <span className="ci-sub">{it.sub}</span>}
                </div>
              </Fragment>
            );
          })}
        </div>
        <div className="cmdk-foot">
          <span className="cf"><span className="kbd">↑</span><span className="kbd">↓</span>选择</span>
          <span className="cf"><span className="kbd">↵</span>打开</span>
          <span className="cf"><span className="kbd">ESC</span>关闭</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================ App
export default function App() {
  const { path, params } = useHashRoute();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [username, setUsername] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [globalOnline, setGlobalOnline] = useState<boolean | null>(null);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('tw-rail') !== '0');
  const [cmdkOpen, setCmdkOpen] = useState(false);

  useEffect(() => {
    const l = (t: Toast) => {
      setToasts(ts => [...ts, t]);
      setTimeout(() => setToasts(ts => ts.filter(x => x.id !== t.id)), t.err ? 5000 : 2600);
    };
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      const me = await api.me();
      setUsername(me.username);
      setAuthed(true);
    } catch {
      setAuthed(false);
    }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);
  useEffect(() => { localStorage.setItem('tw-rail', railOpen ? '1' : '0'); }, [railOpen]);

  // 全局节点状态（15s）。走 usePolling：页面隐藏时不再空转，
  // 且数据未变时保留旧引用，避免每 15s 把整棵树重渲染一遍（下方 memo 才生效）。
  usePolling(alive => {
    if (!authed) return;
    void api.servers().then(({ servers }) => {
      if (!alive()) return; // 切路由后旧请求迟到，不要写回
      setServers(prev => keepRef(prev, servers));
      setGlobalOnline(servers.length > 0 && servers.every(s => s.live.state === 'online'));
    }).catch(() => { /* noop */ });
  }, 15000, [authed, path]);

  // Ctrl/Cmd + K 打开快速检索
  useEffect(() => {
    if (!authed) return;
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen(o => !o);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [authed]);

  if (authed === null) return <div className="login-wrap"><div className="login-sub">loading…</div></div>;
  if (!authed || path === '/login') return <Login onOk={(u) => { setUsername(u); setAuthed(true); nav('/sessions'); }} />;

  const isTerm = path === '/terminal';
  const view =
    path === '/terminal' ? <Terminal params={params} /> :
    path === '/servers' ? <Servers /> :
    path === '/settings' ? <Settings /> :
    <Overview />;

  const onlineCount = servers.filter(s => s.live.state === 'online').length;
  const srvParam = params.get('server');

  return (
    <div className="app">
      {!isTerm && (
        <aside className={`rail ${railOpen ? '' : 'closed'}`}>
          <div className="rail-head">
            {railOpen ? (
              <>
                <a href="#/sessions" className="rail-brand">
                  <span className="rail-mark">&gt;_</span>
                  <span className="rail-name">tmux 管理台</span>
                  <span className="rail-ver">v0.1</span>
                </a>
                <button className="rail-toggle" onClick={() => setRailOpen(false)} title="收起导航">⟨</button>
              </>
            ) : (
              <button className="rail-expand" onClick={() => setRailOpen(true)} title="展开导航" aria-label="展开导航">»</button>
            )}
          </div>

          <nav className="rail-nav">
            {NAV.map(n => (
              <a key={n.path} href={`#${n.path}`} className={path === n.path ? 'active' : ''} title={n.label}>
                <span className="ri"><n.Icon size={15} /></span>
                {railOpen && <span>{n.label}</span>}
              </a>
            ))}
          </nav>

          {railOpen && <div className="rail-section">host nodes</div>}
          {railOpen ? (
            <div className="rail-servers">
              {servers.map(s => {
                const on = srvParam === String(s.id) && path === '/sessions';
                return (
                  <div key={s.id} className="rail-srv">
                    <div className={`rail-srv-h ${on ? 'on' : ''}`}
                      title={`${s.name} · ${connUser(s)}\n${connScope(s.live) || '尚未获取远端身份'}\n点击${on ? '清除' : ''}按该节点筛选会话`}
                      onClick={() => nav(on ? '/sessions' : `/sessions?server=${s.id}`)}>
                      <span className={`dot ${s.live.state}`} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                      {s.live.ident && <span className="rn-user" title={`当前连接身份：${s.live.ident.user}`}>{s.live.ident.user}</span>}
                      <span className="rail-lat">{s.live.latency != null ? `${s.live.latency}ms` : '—'}</span>
                    </div>
                  </div>
                );
              })}
              {servers.length === 0 && (
                <div style={{ color: 'var(--dim)', fontSize: 11, padding: '6px 8px' }}>暂无服务器</div>
              )}
            </div>
          ) : <div style={{ flex: 1 }} />}

          <div className="rail-foot" title={`${onlineCount}/${servers.length} 节点在线`}>
            <span className={`dot ${servers.length > 0 && onlineCount === servers.length ? 'online' : servers.length === 0 ? 'offline' : 'reconnecting'}`} />
            {railOpen && (
              <div style={{ minWidth: 0 }}>
                <div className="rf-k">daemon socket</div>
                <div className="rf-v">{onlineCount}/{servers.length} 节点在线</div>
              </div>
            )}
          </div>
        </aside>
      )}

      <div className="app-main">
        {!isTerm && (
          <header className="statusbar">
            {/* 状态条只放全局控件 —— 页面标题归内容区，避免同一屏出现两份标题 */}
            <div className="csearch" onClick={() => setCmdkOpen(true)} title="快速检索（⌘K / Ctrl+K）">
              <span style={{ display: 'grid', placeItems: 'center' }}><IconSearch size={13} /></span>
              <span className="cs-txt">快速检索会话、节点或页面…</span>
              <span className="kbd">⌘K</span>
            </div>
            <span className="spacer" />
            {globalOnline !== null && (
              <span className={`sb-seg hide-mobile ${globalOnline ? 'ok' : 'warn'}`}>
                <span className={`dot ${globalOnline ? 'online' : 'reconnecting'}`} />
                {globalOnline ? `${onlineCount} 台节点在线` : `${servers.length - onlineCount} 台节点异常`}
              </span>
            )}
            {/* 头像 + 用户名 —— 让「这是账号菜单」一眼可辨，而不是一个孤零零的圆圈 */}
            <div className="user-chip" title={`${username} · 点击退出登录`} onClick={async () => { await api.logout(); setAuthed(false); }}>
              <span className="avatar">{username.slice(0, 1).toUpperCase()}</span>
              <span className="uc-name hide-mobile">{username}</span>
            </div>
          </header>
        )}

        <main className={isTerm ? 'term-page' : 'page'}>
          {/* Suspense 只为按需加载的终端视图兜底；其余视图是同步 import，会立即渲染 */}
          <Suspense fallback={<div className="view-loading">正在加载终端工作区…</div>}>{view}</Suspense>
        </main>
      </div>

      {!isTerm && (
        <nav className="bottomnav">
          {NAV.map(n => (
            <a key={n.path} href={`#${n.path}`} className={path === n.path ? 'active' : ''}>
              <span className="bicon"><n.Icon size={18} /></span>{n.label.replace('工作区', '').replace('管理', '')}
            </a>
          ))}
        </nav>
      )}

      <div className="toasts">
        {toasts.map(t => <div key={t.id} className={`toast ${t.err ? 'err' : ''}`}>{t.msg}</div>)}
      </div>

      {cmdkOpen && <QuickSearch onClose={() => setCmdkOpen(false)} />}
      <DialogHost />
    </div>
  );
}
