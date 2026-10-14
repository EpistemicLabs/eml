import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

type DialogContextValue = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  triggerRef: React.RefObject<HTMLElement | null>;
};

const DialogContext = React.createContext<DialogContextValue | null>(null);

export function useDialog(): DialogContextValue {
  const ctx = React.useContext(DialogContext);
  if (!ctx) {
    throw new Error('Dialog components must be used within a <Dialog>');
  }
  return ctx;
}

function assignRef<T>(ref: React.Ref<T> | undefined, node: T | null) {
  if (typeof ref === 'function') {
    ref(node);
  } else if (ref) {
    ref.current = node;
  }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])';

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

// ---------------------------------------------------------------------------
// Dialog (state provider, no DOM)

type DialogProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  children: React.ReactNode;
};

export function Dialog({ open, onOpenChange, defaultOpen = false, children }: DialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const controlled = open !== undefined;
  const effectiveOpen = controlled ? open : internalOpen;
  const triggerRef = React.useRef<HTMLElement | null>(null);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!controlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  const value = React.useMemo<DialogContextValue>(
    () => ({ open: effectiveOpen, onOpenChange: setOpen, triggerRef }),
    [effectiveOpen, setOpen],
  );

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

// ---------------------------------------------------------------------------
// DialogTrigger

type DialogTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
};

export const DialogTrigger = React.forwardRef<HTMLButtonElement, DialogTriggerProps>(
  function DialogTrigger({ asChild = false, onClick, children, ...rest }, ref) {
    const { onOpenChange, triggerRef } = useDialog();

    const attach = (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      assignRef(ref, node);
    };

    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{
        onClick?: (event: React.MouseEvent) => void;
        ref?: React.Ref<HTMLButtonElement>;
      }>;
      const childClick = child.props.onClick;
      return React.cloneElement(child, {
        onClick: (event: React.MouseEvent) => {
          onOpenChange(true);
          childClick?.(event);
        },
        ref: attach,
      });
    }

    return (
      <button
        type="button"
        ref={attach}
        onClick={(event) => {
          onOpenChange(true);
          onClick?.(event);
        }}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
DialogTrigger.displayName = 'DialogTrigger';

// ---------------------------------------------------------------------------
// DialogContent

type DialogContentProps = React.HTMLAttributes<HTMLDivElement> & {
  onEscapeKeyDown?: () => void;
  onPointerDownOutside?: () => void;
  size?: 'default' | 'fullscreen';
};

const PANEL_CLASS: Record<NonNullable<DialogContentProps['size']>, string> = {
  // The translate must live on `transform` (not Tailwind's `translate`
  // property): the content-show keyframe animates that same transform and
  // ends at translate(-50%, -50%), so the panel settles without a jump.
  default:
    'fixed top-1/2 left-1/2 z-50 w-full max-w-md [transform:translate(-50%,-50%)] frosted rounded-2xl p-0 text-foreground',
  fullscreen: 'fixed inset-0 z-50',
};

export const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  function DialogContent(
    { onEscapeKeyDown, onPointerDownOutside, size = 'default', className, children, ...rest },
    ref,
  ) {
    const { open, onOpenChange, triggerRef } = useDialog();
    const panelRef = React.useRef<HTMLDivElement | null>(null);
    const previouslyFocusedRef = React.useRef<Element | null>(null);

    // Remember what had focus on open; hand it back on close (preferring
    // the trigger). The component stays mounted while closed, so this sees
    // the open -> closed transition.
    React.useEffect(() => {
      if (open) {
        previouslyFocusedRef.current = document.activeElement;
        return;
      }
      const remembered = previouslyFocusedRef.current;
      if (!remembered) return;
      const target = triggerRef.current ?? remembered;
      if (target instanceof HTMLElement) target.focus();
      previouslyFocusedRef.current = null;
    }, [open, triggerRef]);

    // Escape + focus trap (document capture) and body scroll lock.
    React.useEffect(() => {
      if (!open) return;

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onEscapeKeyDown?.();
          onOpenChange(false);
          return;
        }
        if (event.key !== 'Tab' || !panelRef.current) return;
        const items = focusableWithin(panelRef.current);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      };

      const bodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', onKeyDown, true);
      return () => {
        document.removeEventListener('keydown', onKeyDown, true);
        document.body.style.overflow = bodyOverflow;
      };
    }, [open, onOpenChange, onEscapeKeyDown]);

    // Initial focus: first focusable descendant, once the panel has painted.
    React.useEffect(() => {
      if (!open || !panelRef.current) return;
      const frame = window.requestAnimationFrame(() => {
        const panel = panelRef.current;
        if (!panel) return;
        focusableWithin(panel)[0]?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }, [open]);

    if (!open) return null;

    const attachPanel = (node: HTMLDivElement | null) => {
      panelRef.current = node;
      assignRef(ref, node);
    };

    return createPortal(
      <div className="fixed inset-0 z-50">
        <div
          aria-hidden
          className="animate-dialog-overlay-show fixed inset-0 bg-black/20 backdrop-blur-md"
          onClick={() => {
            onPointerDownOutside?.();
            onOpenChange(false);
          }}
        />
        <div
          ref={attachPanel}
          role="dialog"
          aria-modal="true"
          className={cn('animate-dialog-content-show', PANEL_CLASS[size], className)}
          {...rest}
        >
          {children}
        </div>
      </div>,
      document.body,
    );
  },
);
DialogContent.displayName = 'DialogContent';

// ---------------------------------------------------------------------------
// DialogTitle

export const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  function DialogTitle({ className, ...rest }, ref) {
    return <h2 ref={ref} className={cn('sr-only', className)} {...rest} />;
  },
);
DialogTitle.displayName = 'DialogTitle';
