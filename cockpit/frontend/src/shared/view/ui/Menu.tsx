import * as React from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

import { cn } from '@/lib/utils';

import { FOCUS, POPOVER, ROW } from './styles';

export type MenuItem = {
  label: string;
  onSelect: () => void;
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /** Deletes or closes something: drawn in the error red. */
  destructive?: boolean;
  disabled?: boolean;
};

/**
 * A ··· button with a menu of actions. The menu opens below the button (above when there is no
 * room), takes the arrow keys, Home and End, closes on Escape, Tab or a click beside it, and gives
 * the focus back to the button. It portals to the body, so a scrolling or clipped parent can't cut it.
 */
export function Menu({ label, items, className, children, header, footer, align = 'end' }: {
  label: string;
  items: MenuItem[];
  className?: string;
  /** What the button shows; ··· when left out. */
  children?: React.ReactNode;
  /** Read-only content above the actions, e.g. what they act on. */
  header?: React.ReactNode;
  /** Read-only content below the actions, e.g. what choosing one does. */
  footer?: React.ReactNode;
  /** Which edge of the button the menu lines up with: its right edge (default) or its left. */
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = React.useState(false);
  const [place, setPlace] = React.useState<{ top?: number; bottom?: number; right?: number; left?: number } | null>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const menu = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();

  const enabled = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
  const close = React.useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  React.useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const edge = align === 'start' ? { left: rect.left } : { right: window.innerWidth - rect.right };
    const height = menu.current?.offsetHeight ?? 0;
    setPlace(rect.bottom + height > window.innerHeight ? { bottom: window.innerHeight - rect.top, ...edge } : { top: rect.bottom, ...edge });
    enabled()[0]?.focus();
  }, [open, align]);

  React.useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open, close]);

  const onMenuKey = (event: React.KeyboardEvent) => {
    const list = enabled();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { event.preventDefault(); list[(i + list.length) % list.length]?.focus(); };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(list.length - 1);
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') close(false);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => { event.stopPropagation(); setOpen((v) => !v); }}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}
        className={cn('grid size-(--target-min) flex-shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/8 hover:text-foreground', FOCUS, className)}
      >
        {children ?? <MoreHorizontal aria-hidden className="size-4" />}
      </button>
      {open && createPortal(
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          style={place ? { ...place, position: 'fixed' } : { position: 'fixed', visibility: 'hidden' }}
          className={cn(POPOVER, 'min-w-(--size-menu) text-body')}
        >
          {header}
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => { close(); item.onSelect(); }}
              className={cn(ROW, 'disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent', item.destructive && 'text-stopped-ink')}
            >
              {item.icon && <item.icon aria-hidden className="size-4 flex-shrink-0" />}
              {item.label}
            </button>
          ))}
          {footer}
        </div>,
        document.body,
      )}
    </>
  );
}
