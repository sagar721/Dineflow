import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn.ts';

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Buttons for the bottom of the dialog. The primary action goes last. */
  footer?: ReactNode;
  size?: 'sm' | 'md';
};

/**
 * A modal built on the native <dialog> element.
 *
 * `showModal()` gives the behaviour a modal must have and is easy to get wrong by
 * hand: the rest of the page becomes inert, Escape closes it, and focus returns to
 * whatever opened it. No dependency, and nothing to keep in sync with the browser.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // Escape and the native close both route through onClose, so React state
      // stays the single source of truth for whether the dialog is open.
      onClose={onClose}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      className={cn(
        'm-auto w-[calc(100%-2rem)] rounded-lg border border-border bg-surface p-0 text-text shadow-modal',
        'backdrop:bg-text/40',
        size === 'sm' ? 'max-w-sm' : 'max-w-lg',
      )}
    >
      {open ? (
        <div className="flex max-h-[85dvh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold text-text">{title}</h2>
              {description ? <p id={descriptionId} className="mt-1 text-sm text-muted">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-m-1 grid size-9 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
