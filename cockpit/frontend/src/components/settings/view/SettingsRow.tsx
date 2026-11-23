import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type SettingsRowProps = {
  label: ReactNode;
  description?: string;
  children: ReactNode;
  className?: string;
};

export default function SettingsRow({ label, description, children, className }: SettingsRowProps) {
  return (
    // A narrow row (a phone) puts the control under the label instead of squeezing the label.
    <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4', className)}>
      <div className="min-w-0 grow basis-(--size-settings-label)">
        <div className="text-body font-medium text-foreground">{label}</div>
        {description && (
          <div className="mt-0.5 text-body text-muted-foreground">{description}</div>
        )}
      </div>
      <div className="max-w-full flex-shrink-0">{children}</div>
    </div>
  );
}
