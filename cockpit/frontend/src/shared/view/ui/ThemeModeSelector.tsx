import { Monitor, Moon, Sun } from 'lucide-react';

import { useTheme, type ThemeMode } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';

import { TAB, TRACK } from './styles';

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
      className={cn(TRACK, 'inline-flex bg-muted')}
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
            className={cn(TAB, 'px-2 aria-checked:bg-card aria-checked:text-foreground aria-checked:shadow-(--shadow-pill)')}
          >
            <Icon aria-hidden className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
