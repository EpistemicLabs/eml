// A pill-shaped segmented control for a few mutually exclusive options
// (Settings › Models: default provider, provider switch, Codex permissions).
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type SegmentedOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean };

type SettingsSegmentedProps<T extends string> = {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
};

export default function SettingsSegmented<T extends string>({ value, options, onChange, ariaLabel, disabled }: SettingsSegmentedProps<T>) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex items-center gap-0.5 rounded-full border border-border bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled || option.disabled}
          onClick={() => { if (option.value !== value) onChange(option.value); }}
          className={cn(
            'h-6 cursor-pointer rounded-full px-3 text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-muted',
            value === option.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
