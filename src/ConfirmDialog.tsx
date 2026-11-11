import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export type ConfirmOptions = { title: string; body?: ReactNode; confirmLabel: string; cancelLabel?: string };
type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

/**
 * An in-app confirmation instead of the browser's confirm box.
 * `confirm(options)` resolves true when the person presses the confirm button; render `dialog` once.
 */
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })), []);
  const finish = (ok: boolean) => { pending?.resolve(ok); setPending(null); };
  const dialog = pending ? <ConfirmDialog {...pending} onConfirm={() => finish(true)} onCancel={() => finish(false)}/> : null;
  return { confirm, dialog };
}

type Props = ConfirmOptions & { onConfirm: () => void; onCancel: () => void };
export default function ConfirmDialog({ title, body, confirmLabel, cancelLabel = 'Cancel', onConfirm, onCancel }: Props) {
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmButton.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
      <h2 id="confirm-title">{title}</h2>
      {body && <div className="confirm-body">{body}</div>}
      <div className="dialog-actions">
        <button type="button" className="ghost-button" onClick={onCancel}>{cancelLabel}</button>
        <button type="button" ref={confirmButton} className="primary-button" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </section>
  </div>;
}
