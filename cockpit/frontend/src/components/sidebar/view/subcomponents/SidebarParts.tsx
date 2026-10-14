import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/** Tiny uppercase label above a group of rows. */
export function SidebarGroupHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-0.5 text-[10px] font-semibold tracking-wider text-muted-foreground/70 uppercase">
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
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        ) : (
          Icon && <Icon className="h-6 w-6 text-muted-foreground" />
        )}
      </div>
      {heading && <h3 className="mb-1 text-base font-medium text-foreground">{heading}</h3>}
      <p className="text-sm text-muted-foreground">{text}</p>
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
        'flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
        className,
      )}
    >
      {children}
    </button>
  );
}
