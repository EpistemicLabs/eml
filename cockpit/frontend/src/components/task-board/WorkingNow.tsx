// The Inbox's Working now: a column left of the list on a wide screen, a strip of cards above it on a
// narrow one. A row opens in the Inbox split as an Inbox item does. Grey: agents working need nothing.
// A session waiting for a command it started is a row too, with the working hue but no pulse.
import { type BoardTask, isDue, taskName, when } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { commandLine, type WorkingRow, workingCount, workingFor } from '@/lib/working-now';
import { Chip, Dot, FOCUS, LABEL, LINK } from '@/shared/view/ui';

/** How many scheduled runs the column lists; the rest are in Now. */
export const NEXT_RUNS_SHOWN = 3;

function Letter({ row, small }: { row: WorkingRow; small?: boolean }) {
  return (
    <span title={row.agent} className={cn('relative inline-grid shrink-0 place-items-center rounded-full bg-status-agent font-bold text-background', small ? 'size-5 text-caption' : 'size-6 text-ui')}>
      {row.letter}
      <span className="absolute -right-0.5 -bottom-0.5 inline-grid rounded-full bg-card p-px"><Dot hue="agent" live={!row.command} /></span>
    </span>
  );
}

const kindLabel = (row: WorkingRow) => (row.kind === 'member' ? `on ${row.member}'s cockpit` : row.kind);

/** Some row works itself, not only waits for a command: the header's dot pulses. */
const someWork = (rows: WorkingRow[]) => rows.some((row) => !row.command);

export function WorkingColumn({ rows, next, now, current, onOpen, onOpenTask, onShowNow }: {
  rows: WorkingRow[];
  next: BoardTask[];
  now: number;
  /** The row open in the split. */
  current: string | null;
  onOpen: (row: WorkingRow) => void;
  onOpenTask: (task: BoardTask) => void;
  onShowNow: () => void;
}) {
  const shown = next.slice(0, NEXT_RUNS_SHOWN);
  return (
    <aside aria-label="Working now" className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 bg-muted px-3 py-2">
        {rows.length > 0 && <Dot hue="agent" live={someWork(rows)} />}
        <span className={LABEL}>Working now</span>
        <span className="text-caption tabular-nums text-foreground">{workingCount(rows)}</span>
        <span className="ml-auto text-caption text-muted-foreground">all spaces</span>
      </header>
      {rows.length === 0 && (
        <p className="m-0 px-3 py-3 text-ui text-muted-foreground">
          <b className="block font-semibold text-foreground">No agent is working</b>
          {next[0] ? `${isDue(next[0].nextRunAt, now) ? 'Run due since' : 'Next run'} ${when(next[0].nextRunAt, now)}: ${taskName(next[0])}` : 'Agents you start or schedule show up here.'}
        </p>
      )}
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          onClick={() => onOpen(row)}
          aria-current={current === row.key ? 'true' : undefined}
          className={cn('grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 border-t border-border px-3 py-2.5 text-left first-of-type:border-t-0 hover:bg-muted aria-[current=true]:border-l-2 aria-[current=true]:border-l-mark aria-[current=true]:bg-mark/10', FOCUS)}
        >
          <Letter row={row} />
          <span className="line-clamp-2 text-ui font-semibold">{row.name}</span>
          <span className="col-start-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground">
            {row.where && <span className="min-w-0 truncate">{row.where}</span>}
            <Chip>{kindLabel(row)}</Chip>
            {row.since && !row.command && <time title="Working since the turn started" className="tabular-nums">{workingFor(row.since, now)}</time>}
          </span>
          <span className="col-start-2 line-clamp-1 text-caption text-muted-foreground">
            {row.command ? commandLine(row.command, now) : row.waiting ?? (row.step ? <><span className="font-medium text-foreground">Now:</span> {row.step}</> : 'No status line yet')}
          </span>
        </button>
      ))}
      {shown.length > 0 && (
        <div className="flex flex-col border-t border-border pb-1">
          <span className={cn(LABEL, 'px-3 pt-2.5 pb-1')}>Next runs</span>
          {shown.map((t) => (
            <button key={t.id} type="button" onClick={() => onOpenTask(t)} className={cn('grid grid-cols-[auto_minmax(0,1fr)] gap-2 px-3 py-1 text-left text-caption hover:bg-muted', FOCUS)}>
              <time className="tabular-nums text-scheduled-ink">{isDue(t.nextRunAt, now) ? 'due ' : ''}{when(t.nextRunAt, now)}</time>
              <span className="truncate">{taskName(t)}</span>
            </button>
          ))}
          {next.length > shown.length && (
            <button type="button" onClick={onShowNow} className={cn(LINK, 'mx-3 self-start')}>{next.length - shown.length} more in Now</button>
          )}
        </div>
      )}
    </aside>
  );
}

/** On a narrow screen: cards to swipe through, above the Inbox list; nothing while no agent works. */
export function WorkingStrip({ rows, now, onOpen }: { rows: WorkingRow[]; now: number; onOpen: (row: WorkingRow) => void }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Working now" className="flex min-w-0 flex-col gap-2">
      <span className={cn(LABEL, 'flex items-center gap-2')}><Dot hue="agent" live={someWork(rows)} />Working now · {workingCount(rows)}</span>
      <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1">
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            onClick={() => onOpen(row)}
            className={cn('grid w-4/5 max-w-sm shrink-0 snap-start grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-xl border border-border bg-card px-2.5 py-2 text-left', FOCUS)}
          >
            <Letter row={row} small />
            <span className="truncate text-ui font-semibold">{row.name}</span>
            {!row.command && <time className="text-caption tabular-nums text-muted-foreground">{workingFor(row.since, now)}</time>}
            <span className="col-span-2 col-start-2 truncate text-caption text-muted-foreground">{row.command ? commandLine(row.command, now) : row.waiting ?? row.step ?? row.where}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
