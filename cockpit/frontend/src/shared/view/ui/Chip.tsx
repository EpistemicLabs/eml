import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { HUE, type Hue } from './hue';

/** A short label in a status hue (grey without one), and a status dot that can pulse while live. */
export function Chip({ hue, children, className }: { hue?: Hue; children: ReactNode; className?: string }) {
  const h = HUE[hue ?? 'done'];
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 text-caption font-medium', hue ? cn(h.chip, h.ink) : 'bg-muted text-muted-foreground', className)}>
      {children}
    </span>
  );
}

/** Filled while someone acts on it; `hollow` (a ring) while it waits. */
export function Dot({ hue, live = false, hollow = false }: { hue: Hue; live?: boolean; hollow?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-full', hollow ? cn('border-2', HUE[hue].rule) : HUE[hue].dot, live && cn('animate-live', HUE[hue].ink))}
    />
  );
}
