// An engram's type in tokens v2: the type's hue is meaning, so it shows only as a small dot (or a
// graph node); the label, the chip and its fill stay monochrome.
import type { ReactNode } from 'react';

import type { EngramType } from '@/lib/types';
import { cn } from '@/lib/utils';

import { Chip } from './Chip';
import { FOCUS } from './styles';

/** The order types are listed in (filters, legends). */
export const TYPE_ORDER: EngramType[] = [
  'status', 'task', 'note', 'reference', 'decision', 'rule', 'learning', 'event', 'profile', 'log',
];

/** The CSS colour of a type (--type-*, one value per theme). */
export const typeColor = (type: string): string => `var(--type-${type})`;

export function TypeDot({ type, className }: { type: string; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', className)} style={{ backgroundColor: typeColor(type) }} />;
}

/** The type as a label: dot plus name on a grey chip. */
export function TypeBadge({ type, className }: { type: EngramType; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-muted px-2 text-caption font-medium text-foreground', className)}>
      <TypeDot type={type} />
      {type}
    </span>
  );
}

/** A type filter chip: on reads as a raised card, off as an outline; the dot stays in both. */
export function TypeToggle({ type, on, onClick, title, children }: {
  type: string;
  on: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex min-h-(--target-min) items-center gap-1.5 rounded-full border px-2 text-caption font-medium capitalize',
        on ? 'border-border-strong bg-card text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
        FOCUS,
      )}
    >
      <TypeDot type={type} />
      {children ?? type}
    </button>
  );
}

/** Flagged for review: something waits for you, so it is amber. */
export function ReviewFlag() {
  return (
    <Chip hue="you" className="shrink-0 uppercase tracking-label">
      review
    </Chip>
  );
}
