import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface OpgDialogProps {
  title: string;
  value: unknown;
  busy?: boolean;
  notice?: { type: 'success' | 'error'; text: string } | null;
  onClose: () => void;
  children: (requestClose: () => void) => ReactNode;
}

/** Presentation-only dialog guard. Drafts stay in memory; API handlers remain in pages. */
export default function OpgDialog({ title, value, busy = false, notice, onClose, children }: OpgDialogProps) {
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const baseline = useRef(JSON.stringify(value));
  const submitting = useRef(false);
  const busyRef = useRef(busy);
  const [discard, setDiscard] = useState(false);
  const dirty = baseline.current !== JSON.stringify(value);
  busyRef.current = busy;
  const close = () => {
    if (busy || submitting.current) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || []).filter(el => el.getClientRects().length > 0);
    (root.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') || focusable()[0] || root.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); root.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !root.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !root.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, []);
  useEffect(() => { if (!busy) submitting.current = false; }, [busy]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    if (dirty || busy) window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);

  return <div className="modal-overlay" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} tabIndex={-1} className="opg-dialog-root" onSubmitCapture={event => {
      if (busy || discard || submitting.current) { event.preventDefault(); event.stopPropagation(); return; }
      submitting.current = true;
      queueMicrotask(() => { if (!busyRef.current) submitting.current = false; });
    }}>
      <h2 id={titleId} className="opg-sr-only">{title}</h2>
      {notice && <div className={`alert alert-${notice.type} opg-dialog-notice`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      {discard && <div className="opg-discard-notice" role="alert"><strong>放弃未保存的更改？</strong><div className="btn-group"><button autoFocus type="button" className="btn btn-secondary" onClick={() => setDiscard(false)}>继续编辑</button><button type="button" className="btn btn-danger" onClick={onClose}>放弃更改</button></div></div>}
      <fieldset className="opg-dialog-fields" disabled={busy || discard}>{children(close)}</fieldset>
    </div>
  </div>;
}
