import type { ReactNode } from 'react';

/** The placeholder where a list or column has nothing to show. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border p-3 text-ui text-muted-foreground">{children}</div>;
}
