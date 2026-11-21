import * as React from 'react';
import { createPortal } from 'react-dom';

export interface ToastMessage {
  id: string;
  text: string;
  /** Undo and the like: one action, offered until the toast goes. */
  action?: { label: string; run: () => void };
  /** When it goes, as an ISO time (an action's deadline), else after `ms`. */
  until?: string;
  ms?: number;
}

/**
 * One short message at the bottom (tokens v2 glass), announced politely to screen readers. It goes
 * by itself after its time; a new message replaces it.
 */
export function Toast({ message, onDone }: { message: ToastMessage | null; onDone: (id: string) => void }) {
  React.useEffect(() => {
    if (!message) return;
    const left = message.until ? Date.parse(message.until) - Date.now() : message.ms ?? 0;
    const timer = window.setTimeout(() => onDone(message.id), Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [message, onDone]);

  return createPortal(
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-(--z-toast) flex justify-center px-4">
      {message && (
        <div className="animate-fade-in glass-thick pointer-events-auto flex max-w-dialog items-center gap-3 rounded-2xl px-4 py-2 text-body shadow-overlay">
          <span>{message.text}</span>
          {message.action && (
            <button
              type="button"
              onClick={() => { message.action!.run(); onDone(message.id); }}
              className="min-h-(--target-min) shrink-0 font-bold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-(--focus-offset) focus-visible:outline-ring"
            >
              {message.action.label}
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
