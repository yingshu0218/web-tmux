import { useEffect, useState } from 'react';

export interface DialogOpts {
  title: string;
  message: string;
  danger?: boolean;
  /** 需要输入该文本才能确认（分级删除确认） */
  typed?: string;
  okLabel?: string;
  cancelLabel?: string;
}

interface ActiveDialog extends DialogOpts { resolve: (ok: boolean) => void; }

let push: ((d: ActiveDialog) => void) | null = null;

/** 应用内确认弹窗（Promise），替代原生 confirm/prompt */
export function confirmDialog(o: DialogOpts): Promise<boolean> {
  return new Promise(resolve => {
    if (push) push({ ...o, resolve });
    else resolve(false);
  });
}

export function DialogHost() {
  const [dlg, setDlg] = useState<ActiveDialog | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    push = (d) => { setDlg(d); setTyped(''); };
    return () => { push = null; };
  }, []);

  useEffect(() => {
    if (!dlg) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlg]);

  if (!dlg) return null;
  const close = (ok: boolean) => { dlg.resolve(ok); setDlg(null); };
  const okEnabled = !dlg.typed || typed === dlg.typed;

  return (
    <div className="modal-mask" style={{ zIndex: 400 }} onClick={e => { if (e.target === e.currentTarget) close(false); }}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-h" style={dlg.danger ? { color: 'var(--red)' } : undefined}>{dlg.title}</div>
        <div className="modal-b">
          <div style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{dlg.message}</div>
          {dlg.typed && (
            <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
              <label>输入「{dlg.typed}」确认：</label>
              <input value={typed} onChange={e => setTyped(e.target.value)} autoFocus placeholder={dlg.typed} style={{ fontFamily: 'var(--mono)' }} />
            </div>
          )}
        </div>
        <div className="modal-f">
          <button className="btn" onClick={() => close(false)}>{dlg.cancelLabel || '取消'}</button>
          <button className={`btn ${dlg.danger ? 'danger' : 'primary'}`} disabled={!okEnabled} onClick={() => close(true)}>
            {dlg.okLabel || '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
