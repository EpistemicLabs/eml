// Sort this session's topics: the agent proposed where each topic of a drifted session belongs; the
// person changes what is wrong and applies. Nothing starts on its own.
import { useState } from 'react';

import { sortSession, type SortAnswer, type SortPick, type SortRow } from '@/lib/split';
import { cn } from '@/lib/utils';
import { BUTTON, Dialog, DialogContent, DialogTitle, PRIMARY, Select, Table, TableCell, TableRow } from '@/shared/view/ui';

const PICKS: Array<[SortPick, string]> = [
  ['keep', 'Keep on this task'],
  ['sub', 'Sub-task'],
  ['spun', 'Spun off'],
  ['unrelated', 'Unrelated, own task'],
  ['drop', 'Drop it (close its task)'],
];

export function SortDialog({ sessionId, rows: proposed, onClose, onDone }: {
  sessionId: string;
  rows: SortRow[];
  onClose: () => void;
  onDone: (result: Extract<SortAnswer, { ok: true }>) => void;
}) {
  const [rows, setRows] = useState(proposed);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One operation for the dialog: Apply again after an error finishes the same sort.
  const [opId] = useState(() => crypto.randomUUID());
  const pick = (index: number, value: SortPick) => setRows((prev) => prev.map((r, i) => (i === index ? { ...r, pick: value } : r)));

  const apply = async () => {
    setSending(true);
    setError(null);
    const answer = await sortSession(sessionId, rows, opId);
    setSending(false);
    if (!answer.ok) { setError(answer.message); return; }
    onDone(answer);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-labelledby="sort-title" className="glass-thick flex max-h-full w-full max-w-dialog-wide flex-col overflow-y-auto rounded-3xl shadow-modal">
        <DialogTitle className="sr-only">Sort this session's topics</DialogTitle>
        <header className="flex items-start gap-2.5 px-5 pt-4">
          <h3 id="sort-title" className="m-0 flex-1 text-title font-semibold">Sort this session's topics</h3>
          <button type="button" onClick={onClose} aria-label="Close" className={cn(BUTTON, 'min-h-(--target-min) px-2')}>×</button>
        </header>
        <p className="m-0 px-5 pt-0.5 pb-3 text-ui text-muted-foreground">
          {rows.length} topics. The agent proposed where each belongs; change what's wrong. Nothing starts on its own.
        </p>
        <div className="px-5 pb-4">
          <Table label="Topics" head={['When', 'Topic', 'Today', 'Goes to']}>
            {rows.map((row, i) => (
              <TableRow key={`${row.topic}-${i}`}>
                <TableCell className="whitespace-nowrap text-caption tabular-nums text-muted-foreground">{row.when ?? ''}</TableCell>
                <TableCell>
                  <b className="font-semibold">{row.topic}</b>
                  {row.summary && <span className="ml-1.5 text-ui text-muted-foreground">{row.summary}</span>}
                </TableCell>
                <TableCell className="text-ui text-muted-foreground">{row.today ?? ''}</TableCell>
                <TableCell>
                  <Select aria-label={`Where ${row.topic} goes`} value={row.pick} onChange={(e) => pick(i, e.target.value as SortPick)}>
                    {PICKS.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
                  </Select>
                </TableCell>
              </TableRow>
            ))}
          </Table>
          {error && <p role="alert" className="m-0 mt-3 text-ui text-stopped-ink">{error}</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border px-5 pb-4 pt-3">
          <button type="button" className={BUTTON} onClick={onClose}>Cancel</button>
          <button type="button" className={PRIMARY} onClick={() => { void apply(); }} disabled={sending}>{sending ? 'Applying…' : 'Apply'}</button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
