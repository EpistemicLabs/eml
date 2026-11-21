import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { FOCUS, LABEL } from '@/shared/view/ui';

/** A row's hover action: a small bordered square, at the minimum target. */
export const CHIP = cn(
  'flex size-(--target-min) items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-card transition-colors duration-(--duration-fast) hover:bg-muted hover:text-foreground',
  FOCUS,
);
/** The delete action's hover: the stopped hue. */
export const CHIP_DELETE = 'hover:border-status-stopped/40 hover:text-stopped-ink';

/** Tiny uppercase label above a group of rows. */
export function SidebarGroupHeader({ children }: { children: ReactNode }) {
  return (
    <div className={cn(LABEL, 'px-2 py-0.5')}>
      {children}
    </div>
  );
}

/** Centred icon tile with text below: loading, empty and all-hidden states. */
export function SidebarStateBlock({
  icon: Icon,
  spinner = false,
  heading,
  text,
}: {
  icon?: LucideIcon;
  spinner?: boolean;
  heading?: string;
  text: string;
}) {
  return (
    <div className="flex flex-col items-center px-4 py-8 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
        {spinner ? (
          <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        ) : (
          Icon && <Icon aria-hidden className="size-6 text-muted-foreground" />
        )}
      </div>
      {heading && <h3 className="mb-1 text-heading font-medium text-foreground">{heading}</h3>}
      <p className="text-body text-muted-foreground">{text}</p>
    </div>
  );
}

/** Small square action target used in the sessions area's action row. */
export function SidebarIconAction({
  title,
  onActivate,
  className,
  children,
  pressed,
}: {
  title: string;
  onActivate: () => void;
  className?: string;
  children: ReactNode;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      onClick={(event) => {
        event.stopPropagation();
        onActivate();
      }}
      className={cn(
        'flex size-(--target-min) items-center justify-center rounded-md transition-colors duration-(--duration-fast) hover:bg-muted',
        FOCUS,
        className,
      )}
    >
      {children}
    </button>
  );
}
