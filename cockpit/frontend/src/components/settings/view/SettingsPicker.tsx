import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type SettingsPickerProps = {
  items: ReadonlyArray<{ id: string; label: ReactNode }>;
  value: string | undefined;
  onChange: (id: string) => void;
  ariaLabel: string;
};

/** A row of names over the details of the picked one: Settings › Agents and Spaces. */
export default function SettingsPicker({ items, value, onChange, ariaLabel }: SettingsPickerProps) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-x-5 border-b border-border">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={item.id === value}
          onClick={() => onChange(item.id)}
          className={cn(
            '-mb-px flex items-center gap-2 border-b-2 pb-2 text-sm font-medium',
            item.id === value ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
