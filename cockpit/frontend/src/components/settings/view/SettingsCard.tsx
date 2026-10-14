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
        // Subtle elevated surface on the modal material — a tinted overlay
        // (not a solid card fill) so the panel stays glass-like in both
        // themes while still grouping its rows visually.
        'rounded-xl border border-foreground/8 bg-foreground/4',
        divided && 'divide-y divide-foreground/8',
        className,
      )}
    >
      {children}
    </div>
  );
}
