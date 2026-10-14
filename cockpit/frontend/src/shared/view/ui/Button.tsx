import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap',
    'touch-manipulation transition-colors',
    'focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:bg-primary/80',
        destructive:
          'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 active:bg-destructive/80',
        outline:
          'border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground active:bg-accent/80',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80 active:bg-secondary/70',
        ghost: 'hover:bg-accent hover:text-accent-foreground active:bg-accent/80',
        link: 'text-primary underline-offset-4 hover:underline',
        glass: 'frosted text-foreground hover:bg-muted/60 active:bg-muted',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    loading?: boolean;
  };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, className, loading = false, disabled, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 aria-hidden className="animate-spin" />}
      {children}
    </button>
  );
});
Button.displayName = 'Button';
