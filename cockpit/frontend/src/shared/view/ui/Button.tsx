import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

import { FOCUS } from './styles';

/**
 * The v2 button. Primary is the one filled action of a view; secondary (outline) the rest; ghost
 * sits in toolbars and rows; destructive only for what deletes or stops. Every size keeps the
 * 24px minimum target; icon buttons take an aria-label.
 */
const OUTLINE = 'border border-border bg-card text-foreground hover:bg-muted';

export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium',
    'touch-manipulation transition-colors duration-(--duration-fast)',
    'disabled:pointer-events-none disabled:opacity-60',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
    FOCUS,
  ],
  {
    variants: {
      variant: {
        default: 'border border-primary bg-primary text-primary-foreground hover:opacity-90',
        destructive: 'border border-destructive bg-destructive text-destructive-foreground hover:opacity-90',
        outline: OUTLINE,
        secondary: OUTLINE,
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        link: 'text-foreground underline underline-offset-2 hover:no-underline',
        glass: 'glass text-foreground hover:bg-card',
      },
      size: {
        default: 'min-h-(--target-comfortable) px-4 text-body',
        sm: 'min-h-(--target-min) px-3 text-ui',
        lg: 'min-h-(--target-touch) px-6 text-body',
        icon: 'size-(--target-comfortable)',
        'icon-sm': 'size-(--target-min) [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

/** The button classes for elements that are not a <Button> (links, a form's own submit). */
export const BUTTON = buttonVariants({ variant: 'outline' });
export const PRIMARY = buttonVariants();

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    loading?: boolean;
  };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, className, loading = false, disabled, type = 'button', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Loader2 aria-hidden className="animate-spin" />}
      {children}
    </button>
  );
});
Button.displayName = 'Button';
