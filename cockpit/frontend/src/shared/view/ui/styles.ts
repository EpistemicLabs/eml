// Class strings the v2 components share (tokens v2 only: no literal values).
import { cn } from '@/lib/utils';

export const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-(--focus-offset) focus-visible:outline-ring';
export const LABEL = 'text-caption font-semibold uppercase tracking-label text-muted-foreground';
export const BUTTON = cn('inline-flex min-h-(--target-comfortable) items-center justify-center gap-2 rounded-full border border-border bg-card px-4 text-body font-medium text-foreground hover:bg-muted disabled:opacity-60', FOCUS);
export const PRIMARY = cn(BUTTON, 'border-primary bg-primary text-primary-foreground hover:bg-primary hover:opacity-90');
export const MINI = cn('inline-flex min-h-(--target-min) items-center rounded-md border border-border bg-card px-2 text-ui text-muted-foreground hover:bg-background hover:text-foreground', FOCUS);
