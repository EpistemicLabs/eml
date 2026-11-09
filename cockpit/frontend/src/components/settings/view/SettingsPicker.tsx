import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

type SettingsPickerProps = {
  items: ReadonlyArray<{ id: string; label: ReactNode }>;
  value: string | undefined;
  onChange: (id: string) => void;
  ariaLabel: string;
};

/** Tabs on the card with the picked one's details, which sits right under them: Settings › Agents and Spaces. */
export default function SettingsPicker({ items, value, onChange, ariaLabel }: SettingsPickerProps) {
  const active = useRef<HTMLButtonElement>(null);
  // Many tabs scroll sideways; one picked elsewhere comes into view.
  useEffect(() => { active.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [value]);

  return (
    <div role="group" aria-label={ariaLabel} className="flex gap-1 overflow-x-auto">
      {items.map((item) => (
        <button
          key={item.id}
          ref={item.id === value ? active : undefined}
          type="button"
          aria-pressed={item.id === value}
          onClick={() => onChange(item.id)}
          className={cn(
            'flex flex-shrink-0 items-center gap-2 rounded-t-lg border border-b-0 px-3 py-2 text-sm font-medium',
            item.id === value
              ? 'border-foreground/10 text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
