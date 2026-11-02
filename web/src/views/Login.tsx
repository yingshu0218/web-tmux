import { useState } from 'react';
import { api } from '../api';
import { IconUser, IconKey, IconEye, IconEyeOff, IconShield, IconArrowRight } from '../icons';

export default function Login({ onOk }: { onOk: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [totpOn, setTotpOn] = useState(false);
  const [keepAlive, setKeepAlive] = useState(true);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const r = await api.login(username, password);
      onOk(r.username);
    } catch (e: any) {
      setErr(e.message || '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-stage">
        <div className="login-topline">
          <div className="lt-l">
            <span className="dot online" />
            <span>DAEMON RUNNING</span>
          </div>
          <div className="lt-r">
            <span className="lt-chip">HTTPS</span>
            <span className="lt-chip">SSH</span>
          </div>
        </div>

        <form className="login-card" onSubmit={submit}>
          <div className="login-head">
            <div className="login-logo">&gt;_</div>
            <div style={{ minWidth: 0 }}>
              <div className="login-title">
                tmux 管理台
                <span className="tag srvtag">CORE</span>
              </div>
              <div className="login-sub">安全受控的远程 tmux 会话与终端管理平台</div>
            </div>
          </div>

          <div className="lf">
            <div className="lf-head">
              <label htmlFor="username"><IconUser size={13} />管理员账号</label>
              <span className="lf-note">IDENTIFIER</span>
            </div>
            <div className="lf-wrap">
              <span className="lf-ico"><IconUser size={14} /></span>
              <input id="username" value={username} onChange={e => setUsername(e.target.value)}
                placeholder="输入用户凭证" autoFocus autoComplete="username" />
            </div>
          </div>

          <div className="lf">
            <div className="lf-head">
              <label htmlFor="password"><IconKey size={13} />访问密钥</label>
              <span className="lf-note">PASSWORD</span>
            </div>
            <div className="lf-wrap">
              <span className="lf-ico"><IconKey size={14} /></span>
              <input id="password" type={showPwd ? 'text' : 'password'} value={password}
                onChange={e => setPassword(e.target.value)} placeholder="输入密码"
                autoComplete="current-password" style={{ paddingRight: 34 }} />
              <button type="button" className="lf-eye" onClick={() => setShowPwd(v => !v)}
                title={showPwd ? '隐藏密码' : '显示密码'}>
                {showPwd ? <IconEyeOff size={14} /> : <IconEye size={14} />}
              </button>
            </div>
          </div>

          <div className="login-totp">
            <div className="login-totp-h">
              <div className="lth-l">
                <span style={{ color: 'var(--accent)', display: 'grid', placeItems: 'center' }}><IconShield size={15} /></span>
                <span>两步验证（TOTP）</span>
                <span className="lth-badge">预留</span>
              </div>
              <label className="switch" title="TOTP 字段已预留，暂未启用">
                <input type="checkbox" checked={totpOn} onChange={e => setTotpOn(e.target.checked)} />
                <span className="track" />
              </label>
            </div>
            {totpOn && (
              <div className="lf-wrap" style={{ marginTop: 9 }}>
                <span className="lf-ico"><IconKey size={14} /></span>
                <input maxLength={6} placeholder="000000" disabled
                  style={{ letterSpacing: '.35em', textAlign: 'center', height: 34 }} />
              </div>
            )}
            <div className="lt-foot">
              <span>RFC 6238 · 30s</span>
              <span style={{ color: 'var(--dim)' }}>已预留，默认关闭</span>
            </div>
          </div>

          <div className="login-row">
            <label className="login-keep">
              <input type="checkbox" checked={keepAlive} onChange={e => setKeepAlive(e.target.checked)} />
              <span>保持会话活跃</span>
            </label>
            <span className="login-ttl">登录态 30 天</span>
          </div>

          <button className="btn primary" disabled={busy || !username || !password}>
            {busy ? '登录中…' : <>登 录 <IconArrowRight size={14} /></>}
          </button>

          {err && <div className="login-err">{err}</div>}

          <div className="login-note">
            <span className="ln-ico"><IconShield size={14} /></span>
            <div>
              部署在内网管理机，强制 <b>HTTPS</b> 传输加密，SSH 私钥高强度隔离存储。
            </div>
          </div>
        </form>

        <div className="login-foot">
          <span className="lf-l">tmux 管理台 v0.1</span>
          <span className="lf-r"><span className="dot online sm" />凭据本地加密</span>
        </div>
      </div>
    </div>
  );
}
