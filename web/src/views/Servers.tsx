import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../App';
import type { ServerRow, CheckItem } from '../types';
import { confirmDialog } from './Dialog';
import { relTime, connScope } from './Overview';
import { usePolling, keepRef } from '../usePolling';

function statusLabel(s: string) {
  return s === 'online' ? '在线' : s === 'reconnecting' ? '重连中' : '离线';
}

function CheckList({ items, onFix, busy }: { items: CheckItem[]; onFix: (key: string) => void; busy: string | null }) {
  return (
    <div className="check-list">
      {items.map(it => (
        <div key={it.key} className="check-item">
          <span className={`ci-mark ${it.ok ? 'ok' : 'bad'}`}>{it.ok ? '✓' : '✕'}</span>
          <div style={{ flex: 1 }}>
            <div className="ci-label">{it.label}{it.warnOnly && !it.ok && <span className="tag" style={{ marginLeft: 8 }}>不影响可用</span>}</div>
            <div className="ci-detail">{it.detail}</div>
          </div>
          {it.fix === 'fix-linger' && (
            <button className="btn sm" disabled={busy !== null} onClick={() => onFix('fix-linger')}>{busy === 'fix-linger' ? '修复中…' : '一键修复'}</button>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Servers() {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [versions, setVersions] = useState<Record<number, string>>({});
  const [wizard, setWizard] = useState(false);
  const [edit, setEdit] = useState<ServerRow | null>(null);
  const [checking, setChecking] = useState<number | null>(null);
  const [checkResult, setCheckResult] = useState<{ id: number; items: CheckItem[]; passed: boolean } | null>(null);

  const reload = () => api.servers().then(r => setServers(r.servers)).catch(() => {});
  useEffect(() => { reload(); }, []);

  usePolling(alive => {
    void api.sessions().then(r => {
      if (!alive()) return;
      const c: Record<number, number> = {};
      for (const g of r.groups) c[g.serverId] = g.sessions.length;
      setCounts(prev => keepRef(prev, c));
    }).catch(() => {});
  }, 10000, []);

  useEffect(() => {
    // lazy tmux version per online server
    let stop = false;
    (async () => {
      for (const s of servers.filter(x => x.live.state === 'online' && !versions[x.id])) {
        try {
          const v = await api.tmuxVersion(s.id);
          if (!stop) setVersions(vs => ({ ...vs, [s.id]: v.version || '—' }));
        } catch { /* noop */ }
      }
    })();
    return () => { stop = true; };
  }, [servers]); // eslint-disable-line react-hooks/exhaustive-deps

  const del = async (s: ServerRow) => {
    const [g, st] = await Promise.all([
      api.sessions().then(r => r.groups.find(x => x.serverId === s.id)?.sessions.length ?? 0).catch(() => 0),
      api.settings().catch(() => null)
    ]);
    const level = st?.deleteConfirmLevel ?? 'graded';
    const needTyped = level === 'always' || (level === 'graded' && g > 0);
    const msg = (g > 0
      ? `⚠ 该服务器上仍有 ${g} 个 tmux 会话在运行。\n删除仅移除管理端记录与凭据，不影响目标机上的会话。`
      : `删除仅移除管理端记录与凭据，不影响目标机上的 tmux 会话。\n凭据加密数据将一并销毁。`)
      + (needTyped ? `\n\n输入服务器名「${s.name}」以确认。` : '');
    const ok = await confirmDialog({ title: `删除服务器「${s.name}」`, message: msg, danger: true, typed: needTyped ? s.name : undefined, okLabel: '删除' });
    if (!ok) return;
    try { await api.deleteServer(s.id); toast(`已删除 ${s.name}`); reload(); } catch (e: any) { toast(e.message, true); }
  };

  const runCheck = async (id: number) => {
    setChecking(id); setCheckResult(null);
    try {
      const r = await api.checkServer(id);
      setCheckResult({ id, ...r });
      return r;
    } catch (e: any) { toast(e.message, true); return null; }
    finally { setChecking(null); }
  };

  // Esc closes lightweight modals (wizard keeps explicit cancel to avoid losing input)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setCheckResult(null);
      setEdit(null);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const online = servers.filter(s => s.live.state === 'online').length;
  const reconnecting = servers.filter(s => s.live.state === 'reconnecting').length;
  const offline = servers.filter(s => s.live.state === 'offline').length;

  return (
    <div className="content">
      <div className="ov-head">
        <h2>服务器管理</h2>
        <span className="tag hide-mobile">SSH · tmux</span>
        <span style={{ flex: 1 }} />
        <button className="btn sm" title="重新探测全部节点" onClick={reload}>全局探测</button>
        <button className="btn primary sm" onClick={() => setWizard(true)}>+ 添加服务器</button>
      </div>

      <p className="page-sub">
        {servers.length} 台已登记 · {online} 台在线{reconnecting > 0 ? ` · ${reconnecting} 台重连中` : ''}{offline > 0 ? ` · ${offline} 台离线` : ''} · 凭据 AES-256-GCM 加密存储、前端只写不读
      </p>

      <div className="stat-row">
        <div className="stat">
          <span className="st-l">总接入节点</span>
          <span className="st-v">{servers.length}</span>
          <span className="st-s">管理端已登记</span>
        </div>
        <div className={`stat ${online > 0 ? 'ok' : ''}`}>
          <span className="st-l">正常运行</span>
          <span className="st-v">{online}</span>
          <span className="st-s">SSH 可达</span>
        </div>
        <div className={`stat ${reconnecting > 0 ? 'warn' : ''}`}>
          <span className="st-l">重连中</span>
          <span className="st-v">{reconnecting}</span>
          <span className="st-s">心跳失败重试</span>
        </div>
        <div className={`stat ${offline > 0 ? 'bad' : ''}`}>
          <span className="st-l">离线</span>
          <span className="st-v">{offline}</span>
          <span className="st-s">不可达</span>
        </div>
      </div>

      <div className="panel" style={{ overflowX: 'auto' }}>
        <table className="tbl">
          <thead><tr>
            <th>名称</th><th>地址</th><th>连接身份</th><th>状态</th><th>延迟 · 会话</th><th className="hide-mobile">tmux</th><th></th>
          </tr></thead>
          <tbody>
            {servers.map(s => (
              <tr key={s.id}>
                <td style={{ fontWeight: 600 }}>{s.name}</td>
                <td className="mono">{s.username}@{s.host}:{s.port}</td>
                {/* ssh 连上后抓到的实际身份：与配置不一致时（例如默认用户被改）用琥珀色提醒 */}
                <td className="mono" title={connScope(s.live) || '尚未获取远端身份'}>
                  {s.live.ident
                    ? <span className={`conn-user ${s.live.ident.user !== s.username ? 'mismatch' : ''}`}>
                        {s.live.ident.user} · uid {s.live.ident.uid ?? '?'}
                      </span>
                    : <span style={{ color: 'var(--dim)' }}>—</span>}
                </td>
                <td>
                  <span className={`sbadge ${s.live.state === 'online' ? 'live' : s.live.state === 'reconnecting' ? 'warn' : ''}`}>
                    <i />{statusLabel(s.live.state)}
                  </span>
                </td>
                {/* 延迟与会话数合并为一列：两者都是「这行此刻的活跃度」，分开占两列只会把操作列挤窄 */}
                <td className="mono">
                  <span style={s.live.latency != null && s.live.latency < 100 ? { color: 'var(--accent)' } : undefined}>
                    {s.live.latency != null ? `${s.live.latency}ms` : '—'}
                  </span>
                  <span style={{ color: 'var(--dim)' }}> · </span>
                  {s.live.state === 'online' ? `${counts[s.id] ?? '…'} 会话` : '—'}
                </td>
                <td className="mono hide-mobile">{versions[s.id] || '—'}</td>
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                  <button className="btn sm ghost" onClick={() => runCheck(s.id)} disabled={checking === s.id}>{checking === s.id ? '检查中…' : '接入检查'}</button>
                  <button className="btn sm ghost" onClick={() => setEdit(s)}>编辑</button>
                  <button className="btn sm ghost" style={{ color: 'var(--red)' }} onClick={() => del(s)}>删除</button>
                </td>
              </tr>
            ))}
            {servers.length === 0 && <tr><td colSpan={7}><div className="empty">没有服务器，点右上角「+ 添加服务器」</div></td></tr>}
          </tbody>
        </table>
      </div>

      <p style={{ color: 'var(--dim)', fontSize: 11, fontFamily: 'var(--mono)', marginTop: 12, lineHeight: 1.7 }}>
        ※ 删除只删管理端记录和凭据，不动目标机上的 tmux 会话。凭据加密保存（AES-256-GCM），前端只写不读。<br />
        ※ 连接身份是 ssh 登录后实际抓到的用户（<code>id -un</code>），决定能看到哪些 tmux 会话：
        <b>root</b> 可见全部用户的会话；普通用户只能看到自己的（会话按 socket 隔离在 <code>/tmp/tmux-&lt;uid&gt;/</code> 下）。
      </p>

      {wizard && <Wizard onClose={() => { setWizard(false); reload(); }} />}
      {edit && <EditModal s={edit} onClose={() => { setEdit(null); reload(); }} />}

      {checkResult && (
        <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) setCheckResult(null); }}>
          <div className="modal">
            <div className="modal-h">接入检查 · {servers.find(s => s.id === checkResult.id)?.name}
              <span className={`sb-seg ${checkResult.passed ? 'ok' : 'warn'}`} style={{ marginLeft: 'auto' }}>
                <span className={`dot ${checkResult.passed ? 'online' : 'reconnecting'}`} />
                {checkResult.passed ? '可用' : '不可用'}
              </span>
            </div>
            <div className="modal-b">
              <CheckList items={checkResult.items} busy={null} onFix={async (key) => {
                try {
                  if (key === 'fix-linger') {
                    const r = await api.fixLinger(checkResult.id);
                    toast(r.ok ? 'linger 已开启' : `修复失败: ${r.output}`, !r.ok);
                    const rr = await runCheck(checkResult.id);
                    if (rr) setCheckResult({ id: checkResult.id, ...rr });
                  }
                } catch (e: any) { toast(e.message, true); }
              }} />
              <div style={{ display: 'flex', gap: 7, marginTop: 15, flexWrap: 'wrap' }}>
                <button className="btn sm" onClick={() => runCheck(checkResult.id).then(r => r && setCheckResult({ id: checkResult.id, ...r }))}>重新检查</button>
                <button className="btn sm" onClick={async () => {
                  try { const r = await api.pushConf(checkResult.id); toast(`tmux 基础配置已下发 → ${r.path}`); }
                  catch (e: any) { toast(e.message, true); }
                }}>一键下发 tmux 配置</button>
                <span style={{ flex: 1 }} />
                <button className="btn primary sm" onClick={() => setCheckResult(null)}>完成</button>
              </div>
              <p style={{ color: 'var(--dim)', fontSize: 11, marginTop: 11, lineHeight: 1.6 }}>
                ※ linger / tmux 配置 / locale 三项通过 → 服务器标记「可用」。SFTP 不可用不影响可用，只禁用文件功能。
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Wizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(1);
  const [f, setF] = useState({ name: '', host: '', port: 22, username: 'root', auth_type: 'key', privateKey: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [serverId, setServerId] = useState<number | null>(null);
  const [items, setItems] = useState<CheckItem[] | null>(null);
  const [passed, setPassed] = useState(false);
  const set = (k: string, v: any) => setF(x => ({ ...x, [k]: v }));

  const toStep3 = async () => {
    setBusy(true);
    // 第 1 段：入库。只有这一步失败才算「添加失败」——此时没有任何记录产生。
    let id: number;
    try {
      const r = await api.addServer({ ...f, port: Number(f.port) || 22 });
      id = r.id;
      setServerId(id);
    } catch (e: any) {
      toast(e.message, true);
      setBusy(false);
      return;
    }
    // 第 2 段：接入检查。记录此时已经落库了，所以无论检查成功与否都必须进入第 3 步，
    // 否则用户会以为「添加失败」，而服务器其实已经出现在列表里（曾经的坑）。
    try {
      const c = await api.checkServer(id);
      setItems(c.items); setPassed(c.passed);
    } catch (e: any) {
      setItems([{ key: 'check', label: '接入检查未能完成', ok: false, detail: e.message }]);
      setPassed(false);
      toast(`已保存到列表，但接入检查未完成：${e.message}`, true);
    }
    setStep(3);
    setBusy(false);
  };

  const fix = async (key: string) => {
    if (!serverId) return;
    try {
      const r = await api.fixLinger(serverId);
      toast(r.ok ? 'linger 已开启' : `修复失败: ${r.output}`, !r.ok);
      const c = await api.checkServer(serverId);
      setItems(c.items); setPassed(c.passed);
    } catch (e: any) { toast(e.message, true); }
  };

  const step1ok = f.name && f.host && f.username;
  const step2ok = f.auth_type === 'password' ? f.password : f.privateKey;

  return (
    <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget && step !== 3) onClose(); }}>
      <div className="modal">
        <div className="modal-h">添加服务器<span style={{ marginLeft: 'auto' }}><button className="btn sm ghost" onClick={onClose}>取消</button></span></div>
        <div className="modal-b">
          <div className="steps">
            <div className={`step ${step === 1 ? 'on' : 'done'}`}>基本信息</div>
            <div className={`step ${step === 2 ? 'on' : step === 3 ? 'done' : ''}`}>认证方式</div>
            <div className={`step ${step === 3 ? 'on' : ''}`}>接入检查</div>
          </div>

          {step === 1 && (
            <>
              <div className="row2">
                <div className="field"><label>名称</label><input value={f.name} onChange={e => set('name', e.target.value)} placeholder="VPS1" autoFocus /></div>
                <div className="field"><label>端口</label><input type="number" value={f.port} onChange={e => set('port', Number(e.target.value))} /></div>
              </div>
              <div className="field"><label>域名 / IP</label><input value={f.host} onChange={e => set('host', e.target.value)} placeholder="vps1.example.com" /></div>
              <div className="field"><label>用户名</label><input value={f.username} onChange={e => set('username', e.target.value)} /></div>
              <div className="modal-f" style={{ padding: '14px 0 0', borderTop: 'none' }}>
                <button className="btn primary" disabled={!step1ok} onClick={() => setStep(2)}>下一步</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="field">
                <label>认证方式</label>
                <div className="seg">
                  <button className={f.auth_type === 'key' ? 'on' : ''} onClick={() => set('auth_type', 'key')}>私钥</button>
                  <button className={f.auth_type === 'password' ? 'on' : ''} onClick={() => set('auth_type', 'password')}>密码</button>
                </div>
              </div>
              {f.auth_type === 'key' ? (
                <div className="field">
                  <label>私钥（OpenSSH / PEM）</label>
                  <textarea rows={7} value={f.privateKey} onChange={e => set('privateKey', e.target.value)} placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'} style={{ fontSize: 11 }} />
                  <div className="hint">粘贴该服务器的私钥，加密保存、前端只写不读。</div>
                </div>
              ) : (
                <div className="field"><label>密码</label><input type="password" value={f.password} onChange={e => set('password', e.target.value)} /></div>
              )}
              <div className="modal-f" style={{ padding: '14px 0 0', borderTop: 'none' }}>
                <button className="btn" onClick={() => setStep(1)}>上一步</button>
                <button className="btn primary" disabled={!step2ok || busy} onClick={toStep3}>{busy ? '连接中…' : '下一步（开始接入检查）'}</button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              {items ? <CheckList items={items} busy={null} onFix={fix} /> : <div className="empty">检查中…</div>}
              <div style={{ display: 'flex', gap: 7, marginTop: 15 }}>
                <button className="btn sm" onClick={async () => { if (serverId) { const c = await api.checkServer(serverId); setItems(c.items); setPassed(c.passed); } }}>重新检查</button>
                <button className="btn sm" onClick={async () => {
                  if (!serverId) return;
                  try { const r = await api.pushConf(serverId); toast(`已下发 → ${r.path}`); } catch (e: any) { toast(e.message, true); }
                }}>一键下发</button>
                <span style={{ flex: 1 }} />
                <button className="btn primary sm" onClick={onClose}>{passed ? '完成' : '保存（仍可稍后修复）'}</button>
              </div>
              <p style={{ color: 'var(--dim)', fontSize: 11, marginTop: 11, lineHeight: 1.6 }}>
                ※ 该服务器已保存到列表。接入检查未通过不影响保存 —— 可稍后在「服务器管理」里用「编辑」修正凭据，再点「接入检查」重试。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EditModal({ s, onClose }: { s: ServerRow; onClose: () => void }) {
  const [f, setF] = useState({ name: s.name, host: s.host, port: s.port, username: s.username, auth_type: s.auth_type, privateKey: '', password: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF(x => ({ ...x, [k]: v }));
  return (
    <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-h">编辑 · {s.name}<span style={{ marginLeft: 'auto', color: 'var(--dim)', fontSize: 10.5, fontFamily: 'var(--mono)' }}>添加于 {relTime(s.created_at)}</span></div>
        <div className="modal-b">
          <div className="row2">
            <div className="field"><label>名称</label><input value={f.name} onChange={e => set('name', e.target.value)} /></div>
            <div className="field"><label>端口</label><input type="number" value={f.port} onChange={e => set('port', Number(e.target.value))} /></div>
          </div>
          <div className="field"><label>域名 / IP</label><input value={f.host} onChange={e => set('host', e.target.value)} /></div>
          <div className="field"><label>用户名</label><input value={f.username} onChange={e => set('username', e.target.value)} /></div>
          <div className="field">
            <label>凭据（留空则不修改）</label>
            {f.auth_type === 'key'
              ? <textarea rows={5} value={f.privateKey} onChange={e => set('privateKey', e.target.value)} placeholder="粘贴新私钥…" style={{ fontSize: 11 }} />
              : <input type="password" value={f.password} onChange={e => set('password', e.target.value)} placeholder="新密码" />}
          </div>
          <div className="hint" style={{ color: 'var(--dim)' }}>指纹：{s.fingerprint || '（首次连接时记录）'}</div>
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              const patch: any = { name: f.name, host: f.host, port: Number(f.port), username: f.username };
              if (f.privateKey) patch.privateKey = f.privateKey;
              if (f.password) patch.password = f.password;
              await api.updateServer(s.id, patch);
              toast('已保存'); onClose();
            } catch (e: any) { toast(e.message, true); }
            finally { setBusy(false); }
          }}>保存</button>
        </div>
      </div>
    </div>
  );
}
