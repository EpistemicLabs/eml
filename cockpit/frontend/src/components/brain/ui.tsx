// Small building blocks shared by the brain views, in the cockpit's own
// look (the Settings modal's card and section idiom) — packages/web's
// shadcn cards/buttons are deliberately not ported (decision:
// adapt to the cockpit design, don't copy web's).
import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

export function BrainCard({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={cn('rounded-xl border border-foreground/8 bg-foreground/4', className)} style={style}>
      {children}
    </div>
  );
}

/** Section title: uppercase caption with an optional accent dot (type colour). */
export function SectionHeader({
  title,
  accent,
  right,
  className,
}: {
  title: string;
  accent?: string;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3 flex min-h-6 items-center justify-between gap-2', className)}>
      <div className="flex min-w-0 items-center gap-2">
        {accent && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />}
        <h2 className="truncate text-xs font-semibold tracking-wider text-muted-foreground uppercase">{title}</h2>
      </div>
      {right}
    </div>
  );
}

/** A card holding a titled, scrolling list of rows. */
export function ListPanel({
  title,
  accent,
  count,
  action,
  className,
  children,
}: {
  title: string;
  accent?: string;
  count?: number;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <BrainCard className={cn('flex flex-col p-3', className)}>
      <SectionHeader
        title={title}
        accent={accent}
        right={action ?? (count !== undefined ? <span className="text-caption tabular-nums text-muted-foreground">{count}</span> : undefined)}
      />
      <div className="flex max-h-[420px] flex-col gap-1.5 overflow-y-auto pr-1">{children}</div>
    </BrainCard>
  );
}

/** Segmented control (same idiom as the theme-mode selector in Settings). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex items-center gap-0.5 rounded-full border border-border bg-muted p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-6 rounded-full px-2.5 text-caption font-medium capitalize transition-colors',
              active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Small toggle chip (e.g. "Archived 3"). */
export function ToggleChip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        'h-6 rounded-full border px-2.5 text-caption font-medium transition-colors',
        active
          ? 'border-foreground/30 bg-foreground/10 text-foreground'
          : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** ‹ 1/N › pager (status history; the search page will reuse it). */
export function Pager({
  index,
  total,
  onChange,
  olderTitle = 'Older',
  newerTitle = 'Newer',
}: {
  index: number;
  total: number;
  onChange: (index: number) => void;
  olderTitle?: string;
  newerTitle?: string;
}) {
  const button =
    'flex h-6 w-6 items-center justify-center rounded-md border border-border text-caption text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:text-muted-foreground';
  return (
    <div className="flex items-center gap-1 text-caption text-muted-foreground">
      <button type="button" className={button} onClick={() => onChange(index + 1)} disabled={index >= total - 1} title={olderTitle}>
        ‹
      </button>
      <span className="tabular-nums">{index + 1}/{total}</span>
      <button type="button" className={button} onClick={() => onChange(index - 1)} disabled={index <= 0} title={newerTitle}>
        ›
      </button>
    </div>
  );
}

export const EmptyNote = ({ children }: { children: ReactNode }) => (
  <p className="text-ui text-muted-foreground">{children}</p>
);
