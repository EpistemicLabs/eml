import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A slide-over from the right (tokens v2): the view it opened over stays behind a scrim. Escape
 * that nothing inside handled, or a click on the scrim, closes it; focus moves to the element marked data-autofocus (else the
 * first focusable one) once when it opens, stays inside while it is open and goes back to the opener
 * on close. A parent re-render with a new onClose leaves the focus where it is. It portals to the body.
 */
export function Sheet({ open, onClose, labelledBy, className, children }: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  className?: string;
  children: React.ReactNode;
}) {
  const panel = React.useRef<HTMLElement | null>(null);
  // The latest onClose, read by the effect below: callers often pass an inline arrow, and depending
  // on it would re-run the focus move on every parent render (focus jumped to the title while typing).
  const close = React.useRef(onClose);
  React.useLayoutEffect(() => { close.current = onClose; });

  React.useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const frame = window.requestAnimationFrame(() => {
      const root = panel.current;
      const target = root?.querySelector<HTMLElement>('[data-autofocus]') ?? root?.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus({ preventScroll: true });
    });
    const onKey = (event: KeyboardEvent) => {
      // One Esc, one layer: a press something inside already took (the composer stopping a
      // running agent, a search closing) leaves the sheet open; the next one closes it.
      if (event.key === 'Escape') { if (!event.defaultPrevented) { event.preventDefault(); close.current(); } return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement) opener.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-(--z-sheet)">
      <div aria-hidden className="animate-fade-in fixed inset-0 bg-(--scrim)" onClick={onClose} />
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cn(
          'animate-sheet-in glass-thick fixed inset-y-0 right-0 flex w-full max-w-sheet flex-col gap-2.5 rounded-none border-y-0 border-r-0 p-3 shadow-sheet lg:w-11/12',
          className,
        )}
      >
        {children}
      </section>
    </div>,
    document.body,
  );
}
