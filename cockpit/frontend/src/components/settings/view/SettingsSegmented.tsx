// A pill-shaped segmented control for a few mutually exclusive options
// (Settings › Models: default provider, provider switch, Codex permissions).
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { TAB, TRACK } from '@/shared/view/ui';

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
    <div role="radiogroup" aria-label={ariaLabel} className={cn(TRACK, 'inline-flex bg-muted')}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled || option.disabled}
          onClick={() => { if (option.value !== value) onChange(option.value); }}
          className={cn(TAB, 'h-(--target-min) cursor-pointer text-ui disabled:cursor-default disabled:text-muted-foreground aria-checked:bg-card aria-checked:text-foreground aria-checked:shadow-(--shadow-pill)')}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
