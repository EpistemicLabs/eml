// Class strings the v2 components share (tokens v2 only: no literal values).
import { cn } from '@/lib/utils';

export const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-(--focus-offset) focus-visible:outline-ring';
export const LABEL = 'text-caption font-semibold uppercase tracking-label text-muted-foreground';
export const MINI = cn('inline-flex min-h-(--target-min) items-center rounded-md border border-border bg-card px-2 text-ui text-muted-foreground hover:bg-background hover:text-foreground', FOCUS);
/** A text field, text area or select: on the card, its edge strong enough to find (3:1). */
export const FIELD = cn(
  'w-full min-h-(--target-comfortable) rounded-lg border border-input bg-card px-3 text-body text-foreground',
  'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground',
  FOCUS,
);
/** A list row or menu item: full width, at least the minimum target; the picked one sits on a muted fill. */
export const ROW = cn(
  'flex min-h-(--target-min) w-full items-center gap-2 rounded-md px-2 text-left text-body text-foreground',
  'hover:bg-muted aria-selected:bg-muted aria-[current=page]:bg-muted aria-[current=true]:bg-muted',
  FOCUS,
);
/** A small control for paging back and forth (older / newer, previous / next). */
export const PAGER_BUTTON = cn('flex size-(--target-min) items-center justify-center rounded-md border border-border text-caption text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground disabled:cursor-default disabled:border-transparent disabled:hover:text-muted-foreground', FOCUS);
/** One tab and the track around a group of them: the picked tab is raised on the track. */
export const TAB = cn('flex h-(--size-tab) items-center gap-1.5 whitespace-nowrap rounded-(--radius-tab) px-3 text-body font-medium text-muted-foreground hover:text-foreground aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-(--shadow-pill)', FOCUS);
export const TRACK = 'flex items-center gap-0.5 rounded-(--radius-track) p-(--pad-track)';
/** A floating surface over the page: menus and popovers. */
export const POPOVER = 'glass-thick z-(--z-popover) rounded-xl p-1 shadow-overlay';
