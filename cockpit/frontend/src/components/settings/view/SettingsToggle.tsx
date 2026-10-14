import { cn } from '@/lib/utils';

type SettingsToggleProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
};

/**
 * Controlled pill switch for a settings row. Holds no state: it reports the
 * desired value through `onChange` and renders whatever `checked` says.
 */
export default function SettingsToggle({ checked, onChange, ariaLabel, disabled = false }: SettingsToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 touch-manipulation items-center rounded-full border transition-colors duration-200',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
        checked ? 'border-primary bg-primary' : 'border-foreground/10 bg-foreground/10',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none block size-4 rounded-full shadow-sm transition-transform duration-200',
          checked ? 'translate-x-5 bg-white' : 'translate-x-0.5 bg-foreground/50 dark:bg-foreground/70',
        )}
      />
    </button>
  );
}
