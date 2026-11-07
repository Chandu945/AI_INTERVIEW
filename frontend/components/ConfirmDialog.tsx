import { useEffect, useId, useRef, type ReactNode } from 'react';

type Props = {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Red, for something that can't be undone. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Asks to confirm an action, over the page. Esc, Cancel or a click outside it cancels. */
export function ConfirmDialog({ open, title, children, confirmLabel, danger = false, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault(); // Esc: closed by `open` instead
        onCancel();
      }}
      onClick={event => {
        if (event.target === ref.current) onCancel(); // the backdrop
      }}
    >
      <div className="dialog-content">
        <h3 id={titleId}>{title}</h3>
        <div className="dialog-text">{children}</div>
        <div className="dialog-actions">
          <button type="button" className="btn subtle" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
