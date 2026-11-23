import type { ComponentType, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { FOCUS } from './styles';

/** A navigation row's look: the open one is a raised card, the others sit flat on the panel. */
export const NAV_ROW = cn(
  'flex min-h-(--target-comfortable) w-full min-w-0 items-center gap-3 rounded-lg px-2.5 text-left text-body text-foreground',
  'transition-colors duration-(--duration-fast) hover:bg-foreground/8',
  'aria-[current=page]:bg-card aria-[current=page]:font-semibold aria-[current=page]:shadow-card aria-[current=page]:hover:bg-card',
  FOCUS,
);

/** One place to go: icon, name and an optional count; `current` marks the place that is open. */
export function NavItem({ icon: Icon, label, count, current = false, onClick, title, className }: {
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: ReactNode;
  count?: ReactNode;
  current?: boolean;
  onClick: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <button type="button" onClick={onClick} title={title} aria-current={current ? 'page' : undefined} className={cn(NAV_ROW, className)}>
      {Icon && <Icon aria-hidden className="size-4 flex-shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count}
    </button>
  );
}
