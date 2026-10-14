import * as React from 'react';

import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ type, className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          // Faint foreground tint so the field reads as recessed on both palettes.
          'flex h-8 w-full rounded-md border border-foreground/15 bg-foreground/3 px-3 py-1 text-sm transition-colors',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
          'placeholder:text-muted-foreground',
          'focus-visible:border-foreground/30 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...rest}
      />
    );
  },
);
Input.displayName = 'Input';
