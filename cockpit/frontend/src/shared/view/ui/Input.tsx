import * as React from 'react';

import { cn } from '@/lib/utils';

import { FIELD } from './styles';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(FIELD, 'file:border-0 file:bg-transparent file:font-medium', className)} {...rest} />;
  },
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(FIELD, 'py-1.5', className)} {...rest} />;
  },
);
Textarea.displayName = 'Textarea';

/** The native select, dressed as a field: the browser keeps the list, the keyboard and the reader. */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return <select ref={ref} className={cn(FIELD, 'w-auto cursor-pointer pr-2', className)} {...rest} />;
  },
);
Select.displayName = 'Select';

/** A label over its control, with an optional hint or error under it, wired for screen readers. */
export function Field({ label, hint, error, children, className }: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: (ids: { id: string; describedBy?: string }) => React.ReactNode;
  className?: string;
}) {
  const id = React.useId();
  const noteId = `${id}-note`;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-ui font-medium text-foreground">{label}</label>
      {children({ id, describedBy: hint || error ? noteId : undefined })}
      {(error || hint) && (
        <p id={noteId} role={error ? 'alert' : undefined} className={cn('text-ui', error ? 'text-stopped-ink' : 'text-muted-foreground')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
