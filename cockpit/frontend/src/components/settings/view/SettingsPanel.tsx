import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { LABEL } from '@/shared/view/ui';

/** A bordered panel with a small heading. */
export default function SettingsPanel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3', className)}>
      <h4 className={LABEL}>{title}</h4>
      {children}
    </section>
  );
}

/** A line in a panel: a label with a note under it, and controls on the right. */
export function SettingsPanelLine({ label, note, children, noteClassName }: { label: ReactNode; note?: ReactNode; children?: ReactNode; noteClassName?: string }) {
  return (
    <div className="flex items-center gap-3 border-t border-border py-2 first-of-type:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="text-body text-foreground">{label}</div>
        {note && <div className={cn('text-ui text-muted-foreground', noteClassName)}>{note}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
