// Now: every moving task by whose turn it is, starting with what needs the viewer.
import { cardLine, columns, dueLabel, GROUP_META, HUE, readable, TURN_META, type Board, type BoardTask } from '@/lib/task-board';
import { cn } from '@/lib/utils';

import { CardTime, Chip, Dot, Empty, FOCUS, LABEL, Who } from './parts';

export function NowBoard({ board, now, onOpen, movedId }: { board: Board; now: number; onOpen: (task: BoardTask) => void; movedId: string | null }) {
  const cols = columns(board.tasks);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="overflow-x-auto pb-1.5">
        <div className="grid min-w-min grid-flow-col gap-3" style={{ gridTemplateColumns: cols.map((c) => (c.tasks.length ? 'minmax(var(--container-board-col), 1fr)' : 'var(--container-board-col-slim)')).join(' ') }}>
          {cols.map((col) => {
            const meta = TURN_META[col.turn];
            return (
              <section key={col.turn} aria-label={meta.name} className="flex min-w-0 flex-col gap-2">
                <div className={cn('sticky top-0 z-(--z-raised) flex items-center gap-2 border-b-2 bg-background px-0.5 pb-1.5 pt-2', HUE[meta.hue].rule)}>
                  <Dot hue={meta.hue} live={col.turn === 'agent_working' && col.tasks.length > 0} />
                  <h2 title={meta.name} className="m-0 min-w-0 truncate text-body font-semibold">{meta.name}</h2>
                  <span className="ml-auto text-ui tabular-nums text-muted-foreground">{col.tasks.length}</span>
                </div>
                {col.tasks.length > 0 && <p className="m-0 mx-0.5 text-ui text-muted-foreground">{meta.rule}</p>}
                {col.tasks.length === 0 && <Empty>{col.turn === 'agent_working' ? 'No agent is working right now.' : 'Empty.'}</Empty>}
                {col.groups.length > 0
                  ? col.groups.map((g) => (
                    <div key={g.group} className="flex flex-col gap-2">
                      <div className={cn(LABEL, 'mx-0.5 mt-2', HUE[GROUP_META[g.group].hue].ink)}>{GROUP_META[g.group].name} · {g.tasks.length}</div>
                      {g.tasks.map((t) => <Card key={t.id} task={t} now={now} viewer={board.viewer} onOpen={onOpen} moved={movedId === t.id} />)}
                    </div>
                  ))
                  : col.tasks.map((t) => <Card key={t.id} task={t} now={now} viewer={board.viewer} onOpen={onOpen} moved={movedId === t.id} />)}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Card({ task, now, viewer, onOpen, moved }: { task: BoardTask; now: number; viewer: string; onOpen: (task: BoardTask) => void; moved: boolean }) {
  // Content first, metadata last; at most two badges (due and high): the column and group already say the rest.
  const done = task.turn === 'done';
  return (
    <button
      type="button"
      data-task={task.id}
      onClick={() => onOpen(task)}
      className={cn('relative flex w-full flex-col gap-1.5 rounded-xl border border-border bg-card px-3 py-3 text-left shadow-card hover:border-border-strong', FOCUS, moved && 'animate-arrive')}
    >
      <span className="text-heading font-semibold text-pretty">{readable(task.title)}</span>
      <span className="line-clamp-2 text-ui text-muted-foreground">{cardLine(task, now)}</span>
      {task.turn === 'agent_working' && (
        <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-muted"><span className="block h-full w-2/5 bg-status-agent" /></span>
      )}
      {!done && (task.due || task.priority === 'high') && (
        <span className="flex flex-wrap gap-1">
          {task.due && <Chip hue="mark">due {dueLabel(task.due, now)}</Chip>}
          {task.priority === 'high' && <Chip hue="stopped">high</Chip>}
        </span>
      )}
      <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2 border-t border-border/60 pt-2 text-caption text-muted-foreground">
        <span className="min-w-0 truncate">{task.project ? readable(task.project) : task.spaceName}</span>
        <Who task={task} viewer={viewer} />
        <CardTime task={task} now={now} />
      </span>
    </button>
  );
}
