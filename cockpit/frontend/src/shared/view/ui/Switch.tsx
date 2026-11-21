import { cn } from '@/lib/utils';

import { FOCUS } from './styles';

/**
 * A controlled on/off switch. Holds no state: it reports the wanted value through onChange and
 * shows whatever checked says. On is the text colour, off a strong edge, so both read at 3:1.
 */
export function Switch({ checked, onChange, ariaLabel, disabled = false, className }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 touch-manipulation items-center rounded-full border transition-colors duration-(--duration-fast)',
        checked ? 'border-foreground bg-foreground' : 'border-border-strong bg-muted',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        FOCUS,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none block size-4 rounded-full shadow-card transition-transform duration-(--duration-fast)',
          checked ? 'translate-x-5 bg-background' : 'translate-x-0.5 bg-border-strong',
        )}
      />
    </button>
  );
}
