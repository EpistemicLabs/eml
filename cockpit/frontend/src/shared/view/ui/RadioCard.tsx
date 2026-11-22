import type { ReactNode } from 'react';

/**
 * One choice of a few, as a card: a radio, its name and a line on what it does. Put several in a
 * container with role="radiogroup" and an accessible name; the picked card gets the strong edge.
 */
export function RadioCard({ name, value, checked, onChange, title, description, children }: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** More inside the card, under the title (a field the choice needs). */
  children?: ReactNode;
}) {
  return (
    <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-xl border border-border px-2.5 py-2 text-body has-checked:border-foreground has-checked:bg-muted">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="mt-1" />
      <span>
        <b>{title}</b>
        {description && <small className="block text-ui text-muted-foreground">{description}</small>}
        {children}
      </span>
    </label>
  );
}
