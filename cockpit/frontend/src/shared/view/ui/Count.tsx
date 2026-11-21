import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * A count beside a name: grey for "something here", amber when it waits for you, red for
 * something that stopped with an error. The label says what it counts, for the reader and the tooltip.
 */
export function Count({ children, label, tone = 'plain' }: { children: ReactNode; label: string; tone?: 'plain' | 'you' | 'stopped' }) {
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        'inline-grid h-5 min-w-5 flex-shrink-0 place-items-center rounded-full px-1.5 text-caption font-bold leading-none tabular-nums',
        tone === 'you' ? 'bg-status-you/12 text-you-ink' : tone === 'stopped' ? 'bg-status-stopped/12 text-stopped-ink' : 'bg-foreground/8 text-foreground',
      )}
    >
      {children}
    </span>
  );
}
