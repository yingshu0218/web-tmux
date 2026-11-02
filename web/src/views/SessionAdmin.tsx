import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { toast } from '../App';
import { confirmDialog } from './Dialog';
import type { TmuxSession, SessionOptions, TmuxWindow } from '../types';

/**
 * 相对时间。刻意**不从 Overview 导入** —— 总览页会反向引用本组件，
 * 互相 import 会形成循环依赖。这 5 行重复比一个环更划算。
 */
function relTime(ts: number | null): string {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.max(1, Math.floor(d / 1000))} 秒前`;
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  return `${Math.floor(d / 86400_000)} 天前`;
}

const WINDOW_SIZE_OPTS = [
  { v: 'latest', t: 'latest — 跟随最近操作的客户端' },
  { v: 'largest', t: 'largest — 取最大客户端的尺寸' },
  { v: 'smallest', t: 'smallest — 取最小客户端的尺寸' },
  { v: 'manual', t: 'manual — 不随客户端变化（只看不操作时推荐）' }
];

const SCROLL_OPTS = [
  { v: 'view', t: '上滚查看输出内容（推荐）' },
  { v: 'keys', t: '滚轮调历史输入' }
];

interface Draft {
  historyLimit: string;
  windowSize: string;
  destroyUnattached: boolean;
  scrollMode: 'view' | 'keys';
}

/** 从接口返回的选项值还原成表单草稿 */
function draftFrom(o: SessionOptions): Draft {
  return {
    historyLimit: String(o.historyLimit.value ?? '10000'),
    windowSize: o.windowSize.value ?? 'latest',
    destroyUnattached: o.destroyUnattached.value === 'on',
    scrollMode: o.mouse.value === 'off' ? 'keys' : 'view'
  };
}

interface Props {
  serverId: number;
  serverName: string;
  /** 会话对象（含 name / socket / 元信息） */
  info: TmuxSession;
  onClose: () => void;
  /** 重命名成功后回调 —— 父级需要把指向旧名的已打开标签同步改名 */
  onRenamed?: (newName: string) => void;
  /** 会话被终止，或因为关掉最后一个窗口而一并消失 */
  onKilled?: () => void;
  /** 窗口数发生变化（父级可据此刷新） */
  onChanged?: () => void;
}

/**
 * 会话管理面板：重命名 / 会话级参数 / 窗口管理 / 终止。
 * 总览页与终端工作区共用同一个组件，差异通过回调参数化。
 */
export default function SessionAdmin({ serverId, serverName, info, onClose, onRenamed, onKilled, onChanged }: Props) {
  const socket = info.socket ?? null;
  // 重命名后会话名会变，后续所有请求都要用新名 —— 用 cur 跟踪，不依赖父级是否及时更新
  const [cur, setCur] = useState(info.name);
  const [opts, setOpts] = useState<SessionOptions | null>(null);
  const [draft, setDraft] = useState<Draft>({ historyLimit: '10000', windowSize: 'latest', destroyUnattached: false, scrollMode: 'view' });
  const [wins, setWins] = useState<TmuxWindow[]>([]);
  const [name, setName] = useState(info.name);
  const [editWin, setEditWin] = useState<{ index: number; name: string } | null>(null);
  const [newWin, setNewWin] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [loadErr, setLoadErr] = useState('');

  const load = async () => {
    setLoadErr('');
    try {
      const [o, w] = await Promise.all([
        api.sessionOptions(serverId, cur, socket),
        api.windows(serverId, cur, socket)
      ]);
      setOpts(o.options);
      setDraft(draftFrom(o.options));
      setWins(w.windows);
    } catch (e: any) {
      setLoadErr(e.message || '读取会话状态失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 只提交真正改过的字段 —— 避免把「继承全局」的项固化成会话级显式值
  const dirty = useMemo(() => {
    if (!opts) return {} as Record<string, unknown>;
    const base = draftFrom(opts);
    const d: Record<string, unknown> = {};
    if (draft.historyLimit !== base.historyLimit) d.historyLimit = draft.historyLimit;
    if (draft.windowSize !== base.windowSize) d.windowSize = draft.windowSize;
    if (draft.destroyUnattached !== base.destroyUnattached) d.destroyUnattached = draft.destroyUnattached;
    if (draft.scrollMode !== base.scrollMode) d.scrollMode = draft.scrollMode;
    return d;
  }, [draft, opts]);
  const dirtyCount = Object.keys(dirty).length;

  const save = async () => {
    if (!dirtyCount || !opts) return;
    const body: Record<string, unknown> = {};
    if ('historyLimit' in dirty) {
      const n = Number(draft.historyLimit);
      if (!Number.isFinite(n) || n < 100 || n > 1_000_000) {
        setErr('历史缓冲行数需在 100 – 1000000 之间');
        return;
      }
      body.historyLimit = n;
    }
    if ('windowSize' in dirty) body.windowSize = draft.windowSize;
    if ('destroyUnattached' in dirty) body.destroyUnattached = draft.destroyUnattached;
    if ('scrollMode' in dirty) body.mouse = draft.scrollMode === 'keys' ? 'off' : 'on';

    setBusy(true); setErr('');
    try {
      const r = await api.saveSessionOptions(serverId, cur, body, socket);
      setOpts(r.options);
      setDraft(draftFrom(r.options));
      toast('会话参数已保存');
    } catch (e: any) {
      setErr(e.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const doRename = async () => {
    const nn = name.trim();
    if (!nn || nn === cur) return;
    setBusy(true); setErr('');
    try {
      const r = await api.renameSession(serverId, cur, nn, socket);
      setCur(r.name);
      toast(`已重命名为 ${r.name}`);
      onRenamed?.(r.name);
    } catch (e: any) {
      setErr(e.message || '重命名失败');
    } finally {
      setBusy(false);
    }
  };

  const addWin = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.createWindow(serverId, cur, newWin.trim(), socket);
      setWins(r.windows);
      setNewWin('');
      toast('已新建窗口');
      onChanged?.();
    } catch (e: any) {
      setErr(e.message || '新建窗口失败');
    } finally {
      setBusy(false);
    }
  };

  const commitWin = async () => {
    if (!editWin) return;
    const nm = editWin.name.trim();
    if (!nm) { setErr('窗口名不能为空'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.renameWindow(serverId, cur, editWin.index, nm, socket);
      setWins(r.windows);
      setEditWin(null);
      toast('窗口已重命名');
      onChanged?.();
    } catch (e: any) {
      setErr(e.message || '重命名窗口失败');
    } finally {
      setBusy(false);
    }
  };

  /** 切换当前窗口。注意这是会话级动作：所有连到该会话的客户端都会跟着切。 */
  const switchWin = async (index: number) => {
    setBusy(true); setErr('');
    try {
      const r = await api.selectWindow(serverId, cur, index, socket);
      setWins(r.windows);
      toast(`已切换到窗口 ${index}`);
      onChanged?.();
    } catch (e: any) {
      setErr(e.message || '切换窗口失败');
    } finally {
      setBusy(false);
    }
  };

  const removeWin = async (w: TmuxWindow) => {
    const last = wins.length <= 1;
    const ok = await confirmDialog({
      title: `关闭窗口 ${w.index}:${w.name}`,
      message: last
        ? `这是该会话的最后一个窗口 —— tmux 会随之一并结束整个会话「${cur}」，会话内所有进程都会被关闭。\n此操作不可撤销。`
        : `该窗口内的所有进程将被关闭。\n此操作不可撤销。`,
      danger: true,
      okLabel: last ? '关闭窗口并结束会话' : '关闭窗口'
    });
    if (!ok) return;
    setBusy(true); setErr('');
    try {
      const r = await api.killWindow(serverId, cur, w.index, socket);
      setWins(r.windows);
      onChanged?.();
      if (r.lastWindow) {
        toast('会话已随最后一个窗口一并结束');
        onKilled?.();
        onClose();
      } else {
        toast(`窗口 ${r.killed.index} 已关闭`);
      }
    } catch (e: any) {
      setErr(e.message || '关闭窗口失败');
    } finally {
      setBusy(false);
    }
  };

  const killSess = async () => {
    const ok = await confirmDialog({
      title: `终止会话 ${cur}`,
      message: `目标机上该会话内的所有进程将被关闭，滚动历史不再保留。\n此操作不可撤销。`
        + (socket ? `\n\n注意：该会话不在默认 socket 上（${socket}），可能属于其它用户或工具。` : ''),
      danger: true,
      okLabel: '终止会话'
    });
    if (!ok) return;
    setBusy(true); setErr('');
    try {
      await api.killSession(serverId, cur, socket);
      toast(`会话 ${cur} 已终止`);
      onKilled?.();
      onClose();
    } catch (e: any) {
      setErr(e.message || '终止失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" style={{ zIndex: 320 }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 660 }}>
        <div className="modal-h">
          会话管理
          <span className="sa-crumb">{serverName} · {cur}</span>
        </div>

        <div className="modal-b">
          {loadErr ? (
            <div className="sa-err">{loadErr}</div>
          ) : loading ? (
            <div style={{ color: 'var(--dim)', fontSize: 12 }}>读取会话状态…</div>
          ) : (
            <>
              <dl className="kv">
                <dt>服务器</dt><dd>{serverName}</dd>
                <dt>会话名</dt><dd className="mono">{cur}</dd>
                <dt>tmux socket</dt><dd className="mono">{socket || 'default（管理台默认）'}</dd>
                <dt>工作目录</dt><dd className="mono">{info.path || '—'}</dd>
                <dt>窗口 · 客户端</dt>
                <dd className="mono">
                  {wins.length} 个窗口 · {info.attached > 0 ? `${info.attached} 个客户端已连接` : '无客户端连接'}
                </dd>
                <dt>创建 · 活动</dt><dd className="mono">{relTime(info.created)} · {relTime(info.lastActivity)}</dd>
              </dl>

              <div className="sa-sec-t">重命名</div>
              <div className="sa-inline">
                <input className="mono" value={name} placeholder="新会话名"
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void doRename(); }} />
                <button className="btn sm" disabled={busy || !name.trim() || name.trim() === cur} onClick={doRename}>重命名</button>
              </div>
              <div className="sa-hint">
                字母数字开头，可含 <code>.</code> <code>_</code> <code>-</code>，最长 64 字符。
                改名不会中断会话与窗口内容，已连接的终端也不会断开。
              </div>

              <div className="sa-sec-t">会话参数</div>
              <div className="sa-grid">
                <div className="field" style={{ margin: 0 }}>
                  <label>历史缓冲行数（history-limit）</label>
                  <input className="mono" value={draft.historyLimit}
                    onChange={e => setDraft({ ...draft, historyLimit: e.target.value })} />
                  <div className="hint">
                    {opts!.historyLimit.explicit
                      ? '本会话已显式设置'
                      : `未显式设置，当前继承全局（${opts!.historyLimit.global || '默认 10000'}）`}
                    <br />对已存在的窗格不生效，只影响之后新建的窗格。
                  </div>
                </div>

                <div className="field" style={{ margin: 0 }}>
                  <label>窗口尺寸策略（window-size）</label>
                  <select value={draft.windowSize} onChange={e => setDraft({ ...draft, windowSize: e.target.value })}>
                    {WINDOW_SIZE_OPTS.map(o => <option key={o.v} value={o.v}>{o.t}</option>)}
                  </select>
                  <div className="hint">
                    管理台是浏览器客户端，尺寸与真实终端必然不同。
                    默认的 latest 会把管理台的尺寸推给 tmux，可能挤到对方正在用的画面。
                    <br />
                    <b className="sa-warn">实测（tmux 3.3a）：会话没有客户端连接时，本项会在新建窗口后被重置回 latest</b>
                    —— 它只在会话有客户端连接期间保持，所以只适合临时切换，不能当长期策略。
                    <br />
                    要长期生效请改<b>服务器级策略</b>：系统设置 → 终端滚动与历史 → 窗口尺寸策略
                    （全局下发，不会被重置）。
                  </div>
                </div>

                <div className="field" style={{ margin: 0 }}>
                  <label>无客户端时自动销毁（destroy-unattached）</label>
                  <select value={draft.destroyUnattached ? 'on' : 'off'}
                    onChange={async e => {
                      const on = e.target.value === 'on';
                      if (on) {
                        // 后果极重且不可撤销：开启后只要没有客户端连着，tmux 立刻销毁整个会话。
                        // 实测（2026-09-28）：开启的瞬间，一个没有客户端的会话当场消失。
                        const ok = await confirmDialog({
                          title: '开启「无客户端时自动销毁」',
                          message: `开启后，只要该会话没有任何客户端连接，tmux 会立刻结束它 —— 包括你关掉这个管理台标签的那一刻。\n\n后台服务、长跑任务不要开：会话会被连带杀掉，而且不会自动重启。\n\n确认要开启吗？`,
                          danger: true,
                          okLabel: '仍然开启'
                        });
                        if (!ok) {
                          // React 受控组件在这里不会自动回滚（onChange 是异步的），显式还原
                          e.target.value = draft.destroyUnattached ? 'on' : 'off';
                          return;
                        }
                      }
                      setDraft({ ...draft, destroyUnattached: on });
                    }}>
                    <option value="off">关闭 — 无人连接时保持运行（推荐）</option>
                    <option value="on">开启 — 最后一个客户端断开后自动结束会话</option>
                  </select>
                  <div className="hint">开启后，管理台关闭标签这类动作会导致会话消失，长驻任务不要开。</div>
                </div>

                <div className="field" style={{ margin: 0 }}>
                  <label>滚轮行为（mouse）</label>
                  <select value={draft.scrollMode}
                    onChange={e => setDraft({ ...draft, scrollMode: e.target.value as 'view' | 'keys' })}>
                    {SCROLL_OPTS.map(o => <option key={o.v} value={o.v}>{o.t}</option>)}
                  </select>
                  <div className="hint">与终端工作区窗口条上的切换是同一个设置，这里改会立即反映过去。</div>
                </div>
              </div>

              {(dirtyCount > 0 || err) && (
                <div className="sa-save">
                  {err
                    ? <span className="sa-err">{err}</span>
                    : <span className="sa-dirty">{dirtyCount} 项未保存</span>}
                  <span style={{ flex: 1 }} />
                  <button className="btn sm" disabled={busy} onClick={() => { setErr(''); void load(); }}>放弃改动</button>
                  <button className="btn sm primary" disabled={busy || !dirtyCount} onClick={save}>保存参数</button>
                </div>
              )}

              <div className="sa-sec-t">窗口（{wins.length}）</div>
              <div className="sa-wins">
                {wins.map(w => (
                  <div key={w.index} className={`sa-win${w.active ? ' on' : ''}`}>
                    <span className="sa-win-i mono">{w.index}</span>
                    {editWin?.index === w.index ? (
                      <input className="mono sa-win-edit" autoFocus value={editWin.name}
                        onChange={e => setEditWin({ index: w.index, name: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void commitWin();
                          if (e.key === 'Escape') setEditWin(null);
                        }} />
                    ) : (
                      <span className="sa-win-n mono">{w.name}</span>
                    )}
                    {w.active && <span className="sa-win-b">当前</span>}
                    <span style={{ flex: 1 }} />
                    {editWin?.index === w.index ? (
                      <>
                        <button className="btn sm ghost" onClick={() => setEditWin(null)}>取消</button>
                        <button className="btn sm primary" disabled={busy} onClick={commitWin}>保存</button>
                      </>
                    ) : (
                      <>
                        <button className="btn sm ghost" disabled={busy || w.active}
                          title={w.active ? '已经是当前窗口' : '把所有连接的客户端切到这个窗口'}
                          onClick={() => void switchWin(w.index)}>切换</button>
                        <button className="btn sm ghost" disabled={busy}
                          onClick={() => { setErr(''); setEditWin({ index: w.index, name: w.name }); }}>重命名</button>
                        <button className="btn sm ghost" disabled={busy} style={{ color: 'var(--red)' }}
                          onClick={() => void removeWin(w)}>关闭</button>
                      </>
                    )}
                  </div>
                ))}
                {wins.length === 0 && <div className="sa-hint" style={{ margin: 0 }}>没有窗口（会话可能刚刚结束）</div>}
              </div>

              <div className="sa-inline" style={{ marginTop: 10 }}>
                <input className="mono" value={newWin} placeholder="新窗口名（可留空，用 tmux 默认名）"
                  onChange={e => setNewWin(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void addWin(); }} />
                <button className="btn sm" disabled={busy} onClick={addWin}>+ 新建窗口</button>
              </div>
              <div className="sa-hint">
                新窗口会在会话的工作目录下启动。关掉最后一个窗口时 tmux 会连带结束整个会话，届时有二次确认。
              </div>
            </>
          )}
        </div>

        <div className="modal-f">
          <button className="btn danger" style={{ marginRight: 'auto' }} disabled={busy || loading || !!loadErr} onClick={killSess}>
            终止会话
          </button>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
