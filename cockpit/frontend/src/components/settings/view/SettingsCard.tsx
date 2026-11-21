import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type SettingsCardProps = {
  children: ReactNode;
  className?: string;
  divided?: boolean;
};

export default function SettingsCard({ children, className, divided }: SettingsCardProps) {
  return (
    <div
      className={cn(
        // A card on the glass panel: it groups its rows on a solid surface.
        'rounded-xl border border-border bg-card shadow-card',
        divided && 'divide-y divide-border',
        className,
      )}
    >
      {children}
    </div>
  );
}
