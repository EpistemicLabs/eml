// Plan: everything open in every space, by project, most urgent first; up top, the important tasks
// split into those nothing moves without the viewer and those an agent covers.
import { useState } from 'react';

import { type Board, type BoardTask, COVERAGE_META, coverageText, dueLabel, focus, hueOf, projectRows, quietProjects, readable, resolveFilter, taskName, TURN_META, visibleInPlan } from '@/lib/task-board';
import { ProjectsSection, type PlanSpace } from '@/components/projects/ProjectsSection';
import type { ProjectActions } from '@/components/projects/useProjectActions';
import type { ProjectsBySpace } from '@/hooks/useProjectsState';
import { cn } from '@/lib/utils';
import { Chip, Dot, FOCUS, HUE, LABEL, MINI } from '@/shared/view/ui';
import { paneSpaceKey, useSpaces } from '@/stores/useSpaceStore';
import { setTaskFilter, useTaskFilter } from '@/stores/useTaskFilterStore';

import { FilterBar } from './FilterBar';
import { Who } from './parts';

const PLAN_ROW = 'grid grid-cols-(--grid-plan-row) items-center gap-2 px-3 py-2 max-md:grid-cols-(--grid-plan-row-phone) max-md:gap-y-1';
/** A row's space and counts: the table's own cells on a wide screen, a wrapping line under the name on a phone. */
const PLAN_CELLS = 'contents max-md:col-start-2 max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-3 max-md:gap-y-1';

export function PlanView({ board, now, onOpen, onCloseTask, projects, projectActions }: {
  board: Board;
  now: number;
  onOpen: (task: BoardTask) => void;
  onCloseTask: (task: BoardTask) => void;
  /** The cockpit's projects and what can be done to them: the project list at the end of Plan. */
  projects?: ProjectsBySpace;
  projectActions?: ProjectActions;
}) {
  const knownSpaces = useSpaces();
  const filter = resolveFilter(useTaskFilter(), board.spaces);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showQuiet, setShowQuiet] = useState(false);
  const open = board.tasks.filter((t) => visibleInPlan(t, board.viewer, filter));
  const hidden = board.tasks.filter((t) => t.status !== 'resolved' && t.owner && t.owner !== board.viewer && (!filter.spaceId || t.spaceId === filter.spaceId)).length;
  const { act, actCount, covered } = focus(open);
  const rows = projectRows(open, board.projects);
  const quiet = quietProjects(rows, board.projects, filter);
  const toggle = (key: string) => setExpanded((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  // On a phone the table header is hidden: each count carries its label, and a zero is left out.
  const num = (n: number, label: string, ink?: string) => (n
    ? <span className={cn('text-ui tabular-nums', ink)}>{n}<span className="md:hidden"> {label}</span></span>
    : <span aria-label="none" className="tabular-nums text-ui text-muted-foreground max-md:hidden">·</span>);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FilterBar filter={filter} spaces={board.spaces} onChange={setTaskFilter} />

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
        <div className="overflow-hidden rounded-xl border border-border bg-card md:min-w-plan-table">
          <div className={cn(PLAN_ROW, LABEL, 'bg-muted max-md:hidden')}>
            <span /><span>Project</span><span>Space</span><span>Open</span><span>Needs you</span><span>Delegated</span><span>Waiting</span><span>High</span><span>Next due</span>
          </div>
          {rows.map((r) => {
            const isOpen = expanded.has(r.key);
            return (
              <div key={r.key}>
                <button type="button" aria-expanded={isOpen} onClick={() => toggle(r.key)} className={cn(PLAN_ROW, 'w-full border-t border-border text-left text-body hover:bg-muted', FOCUS)}>
                  <span aria-hidden className={cn('inline-block text-muted-foreground transition-transform duration-(--duration-fast)', isOpen && 'rotate-90')}>›</span>
                  <span className="min-w-0 truncate font-semibold">{r.name}{r.goal && <span className="block truncate text-ui font-normal text-muted-foreground">{r.goal}</span>}</span>
                  <span className={PLAN_CELLS}>
                    <Chip>{r.spaceName}</Chip>
                    {num(r.open, 'open')}{num(r.needsYou, 'need you', 'text-you-ink')}{num(r.delegated, 'delegated', 'text-agent-ink')}{num(r.waiting, 'waiting')}{num(r.high, 'high', 'text-stopped-ink')}
                    <span className={cn('tabular-nums text-ui', !r.due && 'max-md:hidden')}>{r.due ? <><span className="md:hidden">due </span>{dueLabel(r.due, now)}</> : '·'}</span>
                  </span>
                </button>
                {isOpen && (
                  <div className="flex flex-col border-t border-border bg-background py-1 pl-10 pr-3 max-md:pl-3">
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
                  <Chip className="max-md:col-start-2 max-md:justify-self-start">{board.spaces.find((s) => s.id === p.spaceId)?.name ?? ''}</Chip>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      {projects && projectActions && (
        <ProjectsSection
          projects={projects}
          actions={projectActions}
          spaces={board.spaces
            .filter((s) => !filter.spaceId || s.id === filter.spaceId)
            .map((s): PlanSpace => {
              const known = knownSpaces.find((k) => k.id === s.id);
              return { key: known ? paneSpaceKey(known) ?? '' : s.id, name: s.name };
            })}
        />
      )}
    </div>
  );
}

function FocusItem({ task, onOpen, chip, side }: { task: BoardTask; onOpen: (task: BoardTask) => void; chip: React.ReactNode; side?: string }) {
  return (
    <button type="button" onClick={() => onOpen(task)} className={cn('-mx-1.5 flex min-w-0 flex-wrap items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-body hover:bg-muted sm:flex-nowrap', FOCUS)}>
      <span className="min-w-0 flex-1 basis-full truncate sm:basis-auto">{taskName(task)}</span>
      <span className="whitespace-nowrap text-caption text-muted-foreground">{side ?? (task.project ? readable(task.project) : task.spaceName)}</span>
      {chip}
    </button>
  );
}

function PlanTask({ task, step, viewer, now, onOpen, onClose }: { task: BoardTask; step: boolean; viewer: string; now: number; onOpen: (task: BoardTask) => void; onClose: (task: BoardTask) => void }) {
  const hue = hueOf(task);
  const state = task.group === 'nobody' ? 'nobody on it' : task.group === 'asked' ? 'asked you' : task.group === 'parent' ? 'waits for parent' : task.turn ? TURN_META[task.turn].name.toLowerCase() : task.status;
  return (
    // On a phone the title wraps, its chips go under it and Close under those.
    <div className={cn('flex items-center gap-2 rounded-lg border border-transparent pr-2 hover:border-border hover:bg-card max-md:flex-wrap max-md:gap-y-0 max-md:pb-1.5', step && 'ml-6 max-md:ml-4')}>
      <button type="button" onClick={() => onOpen(task)} className={cn('grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-body max-md:basis-full max-md:grid-cols-[auto_minmax(0,1fr)] max-md:items-start max-md:gap-y-1', FOCUS)}>
        {/* On a phone the dot stays on the title's first line. */}
        <span className="contents max-md:flex max-md:h-lh max-md:items-center"><Dot hue={hue} /></span>
        <span className="min-w-0 truncate max-md:whitespace-normal">{step && <span className="text-ui text-muted-foreground">↳ </span>}{taskName(task)}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground max-md:col-start-2">
          <Chip hue={hue}>{state}</Chip>
          {task.priority === 'high' && <Chip hue="stopped">high</Chip>}
          {task.due && <Chip hue="mark">{dueLabel(task.due, now)}</Chip>}
          <Who task={task} viewer={viewer} />
        </span>
        {task.statusLine && <span className="col-start-2 col-end-4 min-w-0 truncate text-ui text-muted-foreground max-md:col-end-3 max-md:whitespace-normal">{task.statusLine.now}</span>}
      </button>
      {task.status !== 'resolved' && <button type="button" className={cn(MINI, 'max-md:ml-6.5')} title="Close: the task is not needed" onClick={() => onClose(task)}>Close</button>}
    </div>
  );
}
