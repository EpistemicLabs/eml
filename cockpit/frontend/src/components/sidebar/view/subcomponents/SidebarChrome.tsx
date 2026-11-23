import { X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { FOCUS } from '@/shared/view/ui';
import type { SidebarError } from '../../types';

/** A failed sidebar action, red, until it is dismissed. */
export function SidebarErrorLine({ error, onDismiss }: { error: SidebarError | null; onDismiss: () => void }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="mx-2 mb-1 flex flex-shrink-0 items-start gap-2 rounded-md bg-status-stopped/10 py-0.5 pr-0.5 pl-2 text-ui text-stopped-ink"
    >
      <span className="min-w-0 flex-1 self-center break-words">{error.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}
        className={cn('flex size-(--target-min) flex-shrink-0 items-center justify-center rounded-md text-stopped-ink transition-colors duration-(--duration-fast) hover:bg-status-stopped/12', FOCUS)}
      >
        <X aria-hidden className="size-3" />
      </button>
    </div>
  );
}
