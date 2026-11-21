// Plan: everything open in every space, by project, most urgent first; up top, the important tasks
// split into those nothing moves without the viewer and those an agent covers.
import { useState } from 'react';

import {
  COVERAGE_META, coverageText, dueLabel, focus, HUE, hueOf, projectRows, quietProjects, readable, TURN_META, visibleInPlan,
  type Board, type BoardTask, type PlanFilter,
} from '@/lib/task-board';
import { cn } from '@/lib/utils';

import { Chip, Dot, FOCUS, LABEL, MINI, Who } from './parts';

const SEGMENT = cn('min-h-(--target-min) px-2.5 text-ui text-muted-foreground aria-pressed:bg-foreground aria-pressed:text-background', FOCUS);
const PLAN_ROW = 'grid grid-cols-(--grid-plan-row) items-center gap-2 px-3 py-2';

export function PlanView({ board, now, onOpen, onCloseTask }: { board: Board; now: number; onOpen: (task: BoardTask) => void; onCloseTask: (task: BoardTask) => void }) {
  const [filter, setFilter] = useState<PlanFilter>({ everyone: false, spaceId: null });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showQuiet, setShowQuiet] = useState(false);
  const open = board.tasks.filter((t) => visibleInPlan(t, board.viewer, filter));
  const hidden = board.tasks.filter((t) => t.status !== 'resolved' && t.owner && t.owner !== board.viewer && (!filter.spaceId || t.spaceId === filter.spaceId)).length;
  const { act, actCount, covered } = focus(open);
  const rows = projectRows(open, board.projects);
  const quiet = quietProjects(rows, board.projects, filter);
  const toggle = (key: string) => setExpanded((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const segment = (label: string, pressed: boolean, onClick: () => void) => (
    <button key={label} type="button" aria-pressed={pressed} onClick={onClick} className={SEGMENT}>{label}</button>
  );
  const num = (n: number, ink?: string) => (n ? <span className={cn('text-ui tabular-nums', ink)}>{n}</span> : <span aria-label="none" className="tabular-nums text-ui text-muted-foreground">·</span>);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-ui text-muted-foreground">
        <span className="flex items-center gap-2">Owner
          <span className="inline-flex overflow-hidden rounded-lg border border-border bg-card">
            {segment('Me', !filter.everyone, () => setFilter({ ...filter, everyone: false }))}
            {segment('Everyone', filter.everyone, () => setFilter({ ...filter, everyone: true }))}
          </span>
        </span>
        <span className="flex items-center gap-2">Space
          <span className="inline-flex flex-wrap overflow-hidden rounded-lg border border-border bg-card">
            {segment('All', !filter.spaceId, () => setFilter({ ...filter, spaceId: null }))}
            {board.spaces.map((s) => segment(s.name, filter.spaceId === s.id, () => setFilter({ ...filter, spaceId: s.id })))}
          </span>
        </span>
      </div>

      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-3">
          <h3 className={cn(LABEL, 'm-0 mb-1 flex items-center gap-2 text-you-ink')}>Stuck until you act<span className="ml-auto tabular-nums text-muted-foreground">{actCount} important</span></h3>
          <p className="m-0 mb-1 text-caption text-muted-foreground">Important tasks where nothing happens next unless you do something. The reason says what. Not the same list as Needs you, which counts every task on the board where it is your move.</p>
          {act.length === 0 && <span className="text-ui text-muted-foreground">Nothing needs you.</span>}
          {act.map(({ group, tasks }) => (
            <div key={group} className="flex flex-col">
              <div className={cn(LABEL, 'mt-2', HUE[COVERAGE_META[group].hue].ink)}>{COVERAGE_META[group].name} · {tasks.length}</div>
              {tasks.map((t) => <FocusItem key={t.id} task={t} onOpen={onOpen} chip={<Chip hue={COVERAGE_META[group].hue} className="whitespace-normal">{coverageText(t, now)}</Chip>} />)}
            </div>
          ))}
        </section>
        <section className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-3">
          <h3 className={cn(LABEL, 'm-0 mb-1 flex items-center gap-2 text-agent-ink')}>Agents take care of it<span className="ml-auto tabular-nums text-muted-foreground">{covered.length}</span></h3>
          <p className="m-0 mb-1 text-caption text-muted-foreground">Important tasks with an agent on it: running now, scheduled for a set time, or waiting for a reply an agent will check.</p>
          {covered.length === 0 && <span className="text-ui text-muted-foreground">No agent has an important task right now.</span>}
          {covered.map((t) => <FocusItem key={t.id} task={t} onOpen={onOpen} side={t.due ? `due ${dueLabel(t.due, now)}` : t.priority === 'high' ? 'high' : undefined} chip={<Chip hue="agent" className="whitespace-normal">{coverageText(t, now)}</Chip>} />)}
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2.5 text-ui text-muted-foreground">
        <span>
          Showing <b className="font-semibold text-foreground">{open.length} open tasks</b> in <b className="font-semibold text-foreground">{rows.length} projects</b>
          {!filter.everyone && hidden > 0 && <> · <b className="font-semibold text-foreground">{hidden}</b> owned by others hidden</>}
          {' · '}<b className="font-semibold text-foreground">{quiet.length}</b> projects without an open task of {filter.everyone ? 'anyone' : 'yours'}
        </span>
        <label className="inline-flex min-h-(--target-min) cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={showQuiet} onChange={(e) => setShowQuiet(e.target.checked)} />
          Show projects without open tasks
        </label>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-plan-table overflow-hidden rounded-xl border border-border bg-card">
          <div className={cn(PLAN_ROW, LABEL, 'bg-muted')}>
            <span /><span>Project</span><span>Space</span><span>Open</span><span>Needs you</span><span>Delegated</span><span>Waiting</span><span>High</span><span>Next due</span>
          </div>
          {rows.map((r) => {
            const isOpen = expanded.has(r.key);
            return (
              <div key={r.key}>
                <button type="button" aria-expanded={isOpen} onClick={() => toggle(r.key)} className={cn(PLAN_ROW, 'w-full border-t border-border text-left text-body hover:bg-muted', FOCUS)}>
                  <span aria-hidden className={cn('inline-block text-muted-foreground transition-transform duration-(--duration-fast)', isOpen && 'rotate-90')}>›</span>
                  <span className="min-w-0 truncate font-semibold">{r.name}{r.goal && <span className="block truncate text-ui font-normal text-muted-foreground">{r.goal}</span>}</span>
                  <Chip>{r.spaceName}</Chip>
                  {num(r.open)}{num(r.needsYou, 'text-you-ink')}{num(r.delegated, 'text-agent-ink')}{num(r.waiting)}{num(r.high, 'text-stopped-ink')}
                  <span className="tabular-nums text-ui">{r.due ? dueLabel(r.due, now) : '·'}</span>
                </button>
                {isOpen && (
                  <div className="flex flex-col border-t border-border bg-background py-1 pl-10 pr-3">
                    {r.tasks.map(({ task, step }) => <PlanTask key={task.id} task={task} step={step} viewer={board.viewer} now={now} onOpen={onOpen} onClose={onCloseTask} />)}
                  </div>
                )}
              </div>
            );
          })}
          {showQuiet && quiet.length > 0 && (
            <>
              <div className={cn(PLAN_ROW, LABEL, 'border-t border-border bg-background')}>
                <span /><span>Without an open task · {quiet.length}</span>
              </div>
              {quiet.map((p) => (
                <div key={`${p.spaceId}/${p.id}`} className={cn(PLAN_ROW, 'border-t border-border text-body text-muted-foreground')}>
                  <span />
                  <span className="min-w-0 truncate font-medium">{p.name}{p.goal && <span className="block truncate text-ui font-normal">{p.goal}</span>}</span>
                  <Chip>{board.spaces.find((s) => s.id === p.spaceId)?.name ?? ''}</Chip>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FocusItem({ task, onOpen, chip, side }: { task: BoardTask; onOpen: (task: BoardTask) => void; chip: React.ReactNode; side?: string }) {
  return (
    <button type="button" onClick={() => onOpen(task)} className={cn('-mx-1.5 flex min-w-0 flex-wrap items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-body hover:bg-muted sm:flex-nowrap', FOCUS)}>
      <span className="min-w-0 flex-1 basis-full truncate sm:basis-auto">{readable(task.title)}</span>
      <span className="whitespace-nowrap text-caption text-muted-foreground">{side ?? (task.project ? readable(task.project) : task.spaceName)}</span>
      {chip}
    </button>
  );
}

function PlanTask({ task, step, viewer, now, onOpen, onClose }: { task: BoardTask; step: boolean; viewer: string; now: number; onOpen: (task: BoardTask) => void; onClose: (task: BoardTask) => void }) {
  const hue = hueOf(task);
  const state = task.group === 'nobody' ? 'nobody on it' : task.group === 'asked' ? 'asked you' : task.group === 'parent' ? 'waits for parent' : task.turn ? TURN_META[task.turn].name.toLowerCase() : task.status;
  return (
    <div className={cn('flex items-center gap-2 rounded-lg border border-transparent pr-2 hover:border-border hover:bg-card', step && 'ml-6')}>
      <button type="button" onClick={() => onOpen(task)} className={cn('grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-body', FOCUS)}>
        <Dot hue={hue} />
        <span className="min-w-0 truncate">{step && <span className="text-ui text-muted-foreground">↳ </span>}{readable(task.title)}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
          <Chip hue={hue}>{state}</Chip>
          {task.priority === 'high' && <Chip hue="stopped">high</Chip>}
          {task.due && <Chip hue="mark">{dueLabel(task.due, now)}</Chip>}
          <Who task={task} viewer={viewer} />
        </span>
      </button>
      {task.status !== 'resolved' && <button type="button" className={MINI} title="Close: the task is not needed" onClick={() => onClose(task)}>Close</button>}
    </div>
  );
}
