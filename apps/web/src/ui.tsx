import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, type ActionResult } from './api';
import type { StatusTone } from './format';
import { navigate } from './router';

export function Link({ to, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...rest}
      href={to}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  variant = 'secondary',
  busy,
  className,
  children,
  ...rest
}: { variant?: Variant; busy?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={`btn btn-${variant} ${className ?? ''}`}
    >
      {busy ? '…' : children}
    </button>
  );
}

export function Pill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      {error instanceof Error ? error.message : 'Ошибка'}
    </div>
  );
}

export function Loading() {
  return <div className="muted">Загрузка…</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

// ------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  text: string;
  ok: boolean;
}
const ToastContext = createContext<(text: string, ok?: boolean) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, ok = true) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, ok }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.ok ? '' : 'toast-error'}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** A state-changing call: shows the server's answer as a toast and refreshes every view. */
export function useAction<V>(
  fn: (v: V) => Promise<ActionResult>,
  onDone?: (r: ActionResult) => void,
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      toast(r.message, r.ok);
      onDone?.(r);
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Не удалось выполнить', false),
    onSettled: () => qc.invalidateQueries(),
  });
}

// ------------------------------------------------------------------ dialogs

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** A button that asks for confirmation (optionally with a comment) before running the action. */
export function ConfirmButton({
  label,
  title,
  text,
  confirmLabel,
  variant = 'secondary',
  danger,
  withComment,
  commentRequired,
  commentPlaceholder,
  busy,
  disabled,
  onConfirm,
}: {
  label: ReactNode;
  title: string;
  text: ReactNode;
  confirmLabel: string;
  variant?: Variant;
  danger?: boolean;
  withComment?: boolean;
  commentRequired?: boolean;
  commentPlaceholder?: string;
  busy?: boolean;
  disabled?: boolean;
  onConfirm: (comment: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const close = useCallback(() => setOpen(false), []);
  const canConfirm = !commentRequired || comment.trim().length > 0;
  return (
    <>
      <Button variant={variant} busy={busy} disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <Modal title={title} onClose={close}>
          <div className="modal-text">{text}</div>
          {withComment && (
            <textarea
              autoFocus
              rows={4}
              value={comment}
              placeholder={commentPlaceholder ?? 'Комментарий (необязательно)'}
              onChange={(e) => setComment(e.target.value)}
            />
          )}
          <div className="row end">
            <Button onClick={close}>Нет</Button>
            <Button
              variant={danger ? 'danger' : 'primary'}
              disabled={!canConfirm}
              onClick={() => {
                setOpen(false);
                onConfirm(comment.trim());
                setComment('');
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
