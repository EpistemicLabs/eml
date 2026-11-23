import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { LABEL } from './styles';

/**
 * A table of rows to compare and act on: a header row and hairline rows on the card. Narrow screens
 * scroll it sideways inside its frame (a table keeps its two dimensions); the page itself does not.
 */
export function Table({ label, head, children }: { label: string; head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table aria-label={label} className="w-full border-collapse text-left text-body">
        <thead className="bg-muted">
          <tr>{head.map((h, i) => <th key={i} scope="col" className={cn(LABEL, 'px-3 py-2 font-semibold')}>{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function TableRow({ children }: { children: ReactNode }) {
  return <tr className="border-t border-border align-middle">{children}</tr>;
}

export function TableCell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn('px-3 py-2', className)}>{children}</td>;
}
