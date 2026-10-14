import { Monitor, Moon, Sun } from 'lucide-react';

import { useTheme, type ThemeMode } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';

const MODES: ReadonlyArray<{ value: ThemeMode; icon: typeof Sun; label: string }> = [
  { value: 'system', icon: Monitor, label: 'System' },
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
];

type ThemeModeSelectorProps = {
  ariaLabel?: string;
};

/**
 * Apple-style segmented control for the three theme preferences:
 * System / Light / Dark. The "System" choice tracks the OS via
 * `prefers-color-scheme`; the listener stays armed while in that mode
 * so the app follows live OS switches.
 */
export default function ThemeModeSelector({ ariaLabel }: ThemeModeSelectorProps) {
  const { themeMode, setThemeMode } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel ?? 'Appearance'}
      className="inline-flex items-center gap-0.5 rounded-full border border-border bg-muted p-0.5"
    >
      {MODES.map(({ value, icon: Icon, label }) => {
        const active = themeMode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setThemeMode(value)}
            className={cn(
              'flex h-6 w-9 cursor-pointer items-center justify-center rounded-full transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-muted',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
