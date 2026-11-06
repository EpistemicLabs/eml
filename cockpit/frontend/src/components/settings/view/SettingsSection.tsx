import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type SettingsSectionProps = {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
};

export default function SettingsSection({ title, description, children, className }: SettingsSectionProps) {
  return (
    <div className={cn('space-y-3', className)}>
      <div>
        {title && (
          <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {title}
          </h3>
        )}
        {description && (
          <p className={cn('text-sm text-muted-foreground', title && 'mt-1')}>{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}
