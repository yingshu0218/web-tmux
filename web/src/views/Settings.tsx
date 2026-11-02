import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../App';
import type { Settings, ServerRow, OpLog } from '../types';
import { relTime } from './Overview';

const ACTION_LABEL: Record<string, string> = {
  login_ok: '登录成功', login_fail: '登录失败', password_change: '修改密码',
  server_add: '添加服务器', server_edit: '编辑服务器', server_delete: '删除服务器',
  session_create: '新建会话', session_kill: '终止会话',
  fix_linger: '修复 linger', push_tmux_conf: '下发 tmux 配置', settings_update: '修改设置'
};

const TABS = [
  ['global', '全局参数'], ['security', '安全（密码 / 两步验证）'],
  ['creds', '凭据'], ['quick', '常用指令'], ['logs', '操作日志']
] as const;

export default function SettingsView() {
  const [tab, setTab] = useState<'global' | 'security' | 'creds' | 'quick' | 'logs'>('global');
  const [s, setS] = useState<Settings | null>(null);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [logs, setLogs] = useState<OpLog[]>([]);
  const [quickText, setQuickText] = useState('');

  useEffect(() => {
    api.settings().then(x => { setS(x); setQuickText((x.quickCommands || []).join('\n')); }).catch(() => {});
    api.servers().then(r => setServers(r.servers)).catch(() => {});
    api.logs().then(r => setLogs(r.logs)).catch(() => {});
  }, []);

  const save = async (patch: Partial<Settings>) => {
    try {
      const r = await api.saveSettings(patch);
      setS(r); toast('已保存');
    } catch (e: any) { toast(e.message, true); }
  };

  const num = (v: string) => Math.max(1, Number(v) || 1);

  return (
    <div className="content">
      <div className="ov-head">
        <h2>系统设置</h2>
        <span className="tag hide-mobile">SYSTEM CONFIG</span>
        <span style={{ flex: 1 }} />
        <span className="tag hide-mobile">{TABS.length} 项配置域</span>
      </div>
      <p className="page-sub">
        管理 tmux daemon 探测频率、SSH / WebSocket 链路参数、会话凭据与全局审计策略
      </p>

      <div className="set-tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'global' && s && (
        <div className="cfg-grid" style={{ maxWidth: 940 }}>
          <div className="cfg-card">
            <div className="cfg-h"><span className="cfg-num">01</span><span className="cfg-t">采集与刷新</span></div>
            <div className="field" style={{ margin: 0 }}>
              <label>预览刷新间隔（秒）</label>
              <input type="number" defaultValue={s.previewInterval}
                onBlur={e => num(e.target.value) !== s.previewInterval && save({ previewInterval: num(e.target.value) })} />
            </div>
            <div className="cfg-body">会话卡片终端快照的抓取周期，越短越实时、开销越高。</div>
          </div>

          <div className="cfg-card">
            <div className="cfg-h"><span className="cfg-num">02</span><span className="cfg-t">SSH 链路</span></div>
            <div className="field" style={{ margin: 0 }}>
              <label>心跳间隔 / 连续失败次数</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" defaultValue={s.heartbeatInterval} style={{ width: '50%' }}
                  onBlur={e => num(e.target.value) !== s.heartbeatInterval && save({ heartbeatInterval: num(e.target.value) })} />
                <input type="number" defaultValue={s.heartbeatFails} style={{ width: '50%' }}
                  onBlur={e => num(e.target.value) !== s.heartbeatFails && save({ heartbeatFails: num(e.target.value) })} />
              </div>
            </div>
            <div className="cfg-body">连续失败达到阈值后，节点被标记为离线并进入重连。</div>
          </div>

          <div className="cfg-card">
            <div className="cfg-h"><span className="cfg-num">03</span><span className="cfg-t">WebSocket 链路</span></div>
            <div className="field" style={{ margin: 0 }}>
              <label>心跳 / 超时（秒）</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" defaultValue={s.wsPing} style={{ width: '50%' }}
                  onBlur={e => num(e.target.value) !== s.wsPing && save({ wsPing: num(e.target.value) })} />
                <input type="number" defaultValue={s.wsTimeout} style={{ width: '50%' }}
                  onBlur={e => num(e.target.value) !== s.wsTimeout && save({ wsTimeout: num(e.target.value) })} />
              </div>
            </div>
            <div className="cfg-body">终端长连接的保活与超时判定阈值。</div>
          </div>

          <div className="cfg-card">
            <div className="cfg-h"><span className="cfg-num">04</span><span className="cfg-t">会话与登录</span></div>
            <div className="row2" style={{ gap: 10 }}>
              <div className="field" style={{ margin: 0 }}>
                <label>登录态有效期（天）</label>
                <input type="number" defaultValue={s.loginTtlDays}
                  onBlur={e => num(e.target.value) !== s.loginTtlDays && save({ loginTtlDays: num(e.target.value) })} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>自动重连次数</label>
                <input type="number" min={0} max={10} defaultValue={s.reconnectMax} onBlur={e => {
                  const v = Math.max(0, Math.min(10, Number(e.target.value) || 0));
                  if (v !== s.reconnectMax) save({ reconnectMax: v });
                }} />
              </div>
            </div>
            <div className="cfg-body">自动重连：断开后重试次数；0 = 关闭。重连成功或手动「重连」后计数清零。</div>
          </div>

          <div className="cfg-card">
            <div className="cfg-h"><span className="cfg-num">05</span><span className="cfg-t">安全与删除</span></div>
            <div className="field" style={{ margin: 0 }}>
              <label>删除确认级别</label>
              <select value={s.deleteConfirmLevel} onChange={e => save({ deleteConfirmLevel: e.target.value as any })}>
                <option value="graded">按分级规则</option>
                <option value="always">总是输入名称确认</option>
                <option value="never">仅弹窗确认</option>
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>两步验证（TOTP）</label>
              <select value={s.totpEnabled ? 'on' : 'off'} disabled>
                <option value="off">关闭（已预留）</option>
              </select>
            </div>
            <div className="cfg-body">字段、绑定接口与开关均已预留，后续启用不改结构。</div>
          </div>

          <div className="cfg-card">
            <div className="cfg-h"><span className="cfg-num">06</span><span className="cfg-t">终端滚动与历史</span></div>
            <div className="field" style={{ margin: 0 }}>
              <label>默认滚轮行为</label>
              <select value={s.scrollDefault} onChange={e => save({ scrollDefault: e.target.value as Settings['scrollDefault'] })}>
                <option value="view">上滚查看输出内容（推荐）</option>
                <option value="keys">滚轮调历史输入</option>
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>历史缓冲行数（tmux history-limit）</label>
              <input type="number" min={100} max={1000000} defaultValue={s.historyLimit} onBlur={e => {
                const v = Math.max(100, Math.min(Number(e.target.value) || 10000, 1000000));
                if (v !== s.historyLimit) save({ historyLimit: v });
              }} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>窗口尺寸策略（tmux window-size，服务器级）</label>
              <select value={s.windowSize} onChange={e => save({ windowSize: e.target.value as Settings['windowSize'] })}>
                <option value="latest">latest — 最后连接的客户端说了算（tmux 默认）</option>
                <option value="largest">largest — 最大客户端说了算（小窗口不缩小它）</option>
                <option value="smallest">smallest — 最小客户端说了算</option>
                <option value="manual">manual — 锁定，任何客户端都不改尺寸</option>
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>历史模式下打字自动退出</label>
              <select value={s.scrollExitOnInput ? 'on' : 'off'} onChange={e => save({ scrollExitOnInput: e.target.value === 'on' })}>
                <option value="on">开启（推荐）</option>
                <option value="off">关闭</option>
              </select>
            </div>
            <div className="cfg-body">
              「查看输出内容」由 tmux 接管滚轮，上滚进入历史视图、能翻到浏览器连接之前的输出，滚回底部或按 q 退出；
              「调历史输入」下滚轮会被翻译成 ↑↓ 送进窗格，等于往 shell 里灌方向键。保存后立即下发到所有在线节点的全局与会话。
              历史行数只对<b>新建窗格</b>生效，已存在的窗格需重建会话才会加深。
            </div>
          </div>

          <div className="cfg-card" style={{ justifyContent: 'center' }}>
            <div className="cfg-h"><span className="cfg-num">※</span><span className="cfg-t">生效时机</span></div>
            <div className="cfg-body">心跳与超时改动保存后，对新建的 SSH / WebSocket 连接生效；已有连接需重连后生效。</div>
          </div>
        </div>
      )}

      {tab === 'security' && <SecurityPanel />}

      {tab === 'creds' && (
        <div className="panel" style={{ maxWidth: 800 }}>
          <div className="panel-h">
            <span className="cfg-num">⌘</span>凭据清单
            <span className="cfg-badge" style={{ marginLeft: 'auto' }}>{servers.length} 条</span>
          </div>
          <table className="tbl">
            <thead><tr><th>服务器</th><th>认证方式</th><th>指纹</th></tr></thead>
            <tbody>
              {servers.map(sv => (
                <tr key={sv.id}>
                  <td style={{ fontWeight: 600 }}>{sv.name}</td>
                  <td><span className="tag">{sv.auth_type === 'key' ? '私钥' : '密码'}</span></td>
                  <td className="mono" style={{ color: 'var(--dim)' }}>{sv.fingerprint || '首次连接时记录'}</td>
                </tr>
              ))}
              {servers.length === 0 && <tr><td colSpan={3}><div className="empty">暂无已登记的服务器</div></td></tr>}
            </tbody>
          </table>
          <div className="panel-b" style={{ color: 'var(--dim)', fontSize: 11.5, lineHeight: 1.6 }}>
            ※ 凭据使用 AES-256-GCM 加密存储于管理机本地，密钥不落库；前端只写不读。增改凭据请到 <a href="#/servers" style={{ color: 'var(--primary)' }}>服务器管理</a>。
          </div>
        </div>
      )}

      {tab === 'quick' && s && (
        <div className="panel" style={{ maxWidth: 640 }}>
          <div className="panel-h"><span className="cfg-num">$</span>常用指令</div>
          <div className="panel-b">
            <div className="field">
              <label>每行一条，终端底部快捷输入</label>
              <textarea rows={8} value={quickText} onChange={e => setQuickText(e.target.value)} placeholder={'npm run dev\ngit status'} />
              <div className="hint">保存后显示在终端工作区底部的按键条，点击填入输入框（最多展示前 3 条）。</div>
            </div>
            <button className="btn primary sm" onClick={() => save({ quickCommands: quickText.split('\n').map(x => x.trim()).filter(Boolean) })}>保存</button>
          </div>
        </div>
      )}

      {tab === 'logs' && (
        <div className="panel" style={{ maxWidth: 900 }}>
          <div className="panel-h">
            <span className="cfg-num">▤</span>操作日志
            <span className="cfg-badge" style={{ marginLeft: 'auto' }}>{logs.length} 条</span>
          </div>
          <table className="tbl">
            <thead><tr><th>时间</th><th>操作</th><th>详情</th><th>IP</th></tr></thead>
            <tbody>
              {logs.map(l => (
                <tr key={l.id}>
                  <td className="mono" style={{ color: 'var(--dim)' }}>{new Date(l.at).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>
                    <span className="tag" style={l.action.includes('fail') ? { color: 'var(--red)', borderColor: 'var(--red-line)' } : {}}>
                      {ACTION_LABEL[l.action] || l.action}
                    </span>
                  </td>
                  <td className="mono">{l.detail}</td>
                  <td className="mono" style={{ color: 'var(--dim)' }}>{l.ip}</td>
                </tr>
              ))}
              {logs.length === 0 && <tr><td colSpan={4}><div className="empty">暂无日志</div></td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SecurityPanel() {
  const [oldP, setOldP] = useState('');
  const [newP, setNewP] = useState('');
  const [newP2, setNewP2] = useState('');
  const [me, setMe] = useState<{ username: string; totpEnabled: boolean } | null>(null);
  useEffect(() => { api.me().then(setMe).catch(() => {}); }, []);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, maxWidth: 800 }}>
      <div className="panel">
        <div className="panel-h"><span className="cfg-num">01</span>修改密码</div>
        <div className="panel-b">
          <div className="field"><label>当前密码</label><input type="password" value={oldP} onChange={e => setOldP(e.target.value)} /></div>
          <div className="field"><label>新密码（≥6 位）</label><input type="password" value={newP} onChange={e => setNewP(e.target.value)} /></div>
          <div className="field"><label>确认新密码</label><input type="password" value={newP2} onChange={e => setNewP2(e.target.value)} /></div>
          <button className="btn primary sm" disabled={!oldP || newP.length < 6 || newP !== newP2} onClick={async () => {
            try { await api.changePassword(oldP, newP); toast('密码已更新'); setOldP(''); setNewP(''); setNewP2(''); }
            catch (e: any) { toast(e.message, true); }
          }}>更新密码</button>
          {me && <p style={{ color: 'var(--dim)', fontSize: 11, marginTop: 11, fontFamily: 'var(--mono)' }}>当前账户：{me.username}</p>}
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><span className="cfg-num">02</span>两步验证（TOTP）</div>
        <div className="panel-b" style={{ color: 'var(--muted)', fontSize: 12.5 }}>
          <p style={{ margin: '0 0 8px' }}>已预留，默认关闭。</p>
          <p style={{ color: 'var(--dim)', fontSize: 11.5, lineHeight: 1.65, margin: '0 0 12px' }}>
            启用后登录需输入 6 位动态码（RFC 6238 · 30s）；绑定接口、开关与数据表结构均已就位，后续启用不改结构。
          </p>
          <span className="sbadge"><i />关闭 · 已预留</span>
        </div>
      </div>
    </div>
  );
}
