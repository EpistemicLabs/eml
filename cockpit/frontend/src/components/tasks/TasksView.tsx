// The Tasks view (header › Tasks): today across all spaces — whose turn it is,
// what runs, what is due — and then the projects with their open tasks, the
// ones with something going on first; quiet projects fold away (decision
// tasks-view-by-project-with-daily-project-lead). Scheduled jobs live in the
// Jobs tab. It only reads: tasks change through the agents. A click on a task
// opens its panel with its session's chat (TaskWorkspace); "Work on it today"
// opens the project's desk with today's project lead (lib/project-lead.ts).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Play } from 'lucide-react';

import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { allSessionState } from '@/components/sidebar/allSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import { formatAgo } from '@/components/jobs/jobs';
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace';
import { TriageView, useTriage } from '@/components/tasks/TriageView';
import { openProjectLead, projectIdOfBrain } from '@/lib/project-lead';
import { SPACE_HEADER } from '@/lib/space-header';
import {
  buildOverview, groupByProject, isDue, matches, toOverviewTask,
  type OverviewFilter, type OverviewItem, type OverviewTask, type ProjectGroup, type RawTask, type TaskSession,
} from '@/lib/tasks-overview';
import { cn } from '@/lib/utils';
import { getActiveSpaceId } from '@/stores/usePaneStore';
import { paneSpaceKey, switchSpace, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import { useTurnStore } from '@/stores/useTurnStateStore';
import type { Project } from '@/types/app';

type Loaded = { open: OverviewTask[]; resolved: OverviewTask[] };

async function brainList<T>(space: SpaceInfo, path: string): Promise<T> {
  // Always named: without it the page's fetch would send the active space, and Main would list another space's tasks.
  const res = await fetch(`/api/brain${path}`, { headers: { Accept: 'application/json', [SPACE_HEADER]: space.id } });
  if (!res.ok) throw new Error(`${space.name}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function loadSpace(space: SpaceInfo): Promise<Loaded> {
  const list = (status: string) => brainList<{ engrams: RawTask[] }>(space, `/list?type=task&status=${status}&with_parent=true&limit=500`);
  const [planned, active, resolved, projects] = await Promise.all([
    list('planned'), list('active'), list('resolved'),
    brainList<{ projects: Array<{ id: string; name: string }> }>(space, '/projects').catch(() => ({ projects: [] })),
  ]);
  const names = new Map(projects.projects.map((p) => [p.id, p.name]));
  const to = (raw: RawTask) => toOverviewTask(raw, space, names);
  return { open: [...planned.engrams, ...active.engrams].map(to), resolved: resolved.engrams.map(to) };
}

const SELECT = 'h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground';

export default function TasksView({ projects: cockpitProjects }: { projects?: Project[] }) {
  const spaces = useSpaces();
  const { sessions } = useAllSessions(true);
  const { turns } = useTurnStore();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'open' | 'done' | 'triage'>('open');
  const triage = useTriage();
  const [filter, setFilter] = useState<OverviewFilter>({ spaceId: null, project: null, priority: null, words: '' });
  const [showQuiet, setShowQuiet] = useState(false);
  const [leadError, setLeadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const perSpace = await Promise.all(spaces.map(loadSpace));
      setLoaded({ open: perSpace.flatMap((s) => s.open), resolved: perSpace.flatMap((s) => s.resolved) });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load the tasks');
    }
  }, [spaces]);

  useEffect(() => {
    if (spaces.length === 0) return;
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load, spaces.length]);

  const taskSessions = useMemo<TaskSession[]>(() => (sessions ?? [])
    .filter((s) => s.taskId && !s.archivedAt)
    .map((s) => ({ taskId: s.taskId!, sessionId: s.id, name: sessionDisplayName(s), working: allSessionState(s, turns[s.id]) === 'working' })), [sessions, turns]);

  const overview = useMemo(() => loaded && buildOverview({ ...loaded, jobs: [], sessions: taskSessions, now: new Date() }), [loaded, taskSessions]);
  const keep = (items: OverviewItem[]) => items.filter((i) => matches(i.task, filter));
  const groups = useMemo(() => {
    if (!overview) return [];
    return groupByProject(overview, new Date())
      .map((g) => ({ ...g, items: g.items.filter((i) => matches(i.task, filter)) }))
      .filter((g) => g.items.length > 0);
  }, [overview, filter]);
  const today = new Date().toLocaleDateString('en-CA');

  const [selected, setSelected] = useState<OverviewTask | null>(null);
  const openTask = (task: OverviewTask) => {
    const space = spaces.find((s) => s.id === task.spaceId);
    // The panel reads the active space's brain: a task of another space opens there.
    if (space && paneSpaceKey(space) !== getActiveSpaceId()) switchSpace(space);
    setSelected(task);
  };
  const workOnToday = (group: ProjectGroup) => {
    const space = spaces.find((s) => s.id === group.spaceId);
    if (!space || !group.brainId) return;
    setLeadError(null);
    void openProjectLead(space, projectIdOfBrain(group.brainId), group.name).then((problem) => setLeadError(problem));
  };
  // Its steps' sessions are the task's too.
  const steps = useMemo(() => {
    if (!selected || !loaded) return [];
    return [...loaded.open, ...loaded.resolved].filter((t) => t.parentId === selected.id && t.spaceId === selected.spaceId);
  }, [selected, loaded]);

  const yourTurn = overview ? keep(overview.yourTurn) : [];
  const running = overview ? keep(overview.running) : [];
  const due = overview ? keep([...overview.active, ...overview.planned]).filter((i) => isDue(i.task, today)) : [];
  const activeGroups = groups.filter((g) => g.active);
  const quietGroups = groups.filter((g) => !g.active);
  return (
    <div className="flex min-h-0 flex-1">
    <div className={cn('flex min-h-0 flex-col overflow-y-auto py-5', selected ? 'w-[26rem] flex-shrink-0 px-4' : 'flex-1 px-6')}>
      <div className={cn('w-full', !selected && 'mx-auto max-w-4xl')}>
        <h1 className="text-lg font-semibold text-foreground">Today</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {overview ? `${overview.openCount} open tasks in ${groups.length} projects` : 'Loading…'}
          {yourTurn.length > 0 && <span className="text-primary"> · {yourTurn.length} need{yourTurn.length === 1 ? 's' : ''} you</span>}
          <span className="block text-xs">The view only reads: ask an agent to change a task. Scheduled jobs are in Jobs.</span>
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5">
            {(['open', 'triage', 'done'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)}
                className={cn('rounded px-2.5 py-1 text-sm', tab === t ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {t === 'open' ? 'Open' : t === 'done' ? 'Done · 7 days' : (
                  <>Triage{triage.items.length > 0 && <span className="pl-1.5 text-primary">{triage.items.length}</span>}</>
                )}
              </button>
            ))}
          </div>
          {spaces.length > 1 && (
            <select aria-label="Space" className={SELECT} value={filter.spaceId ?? ''} onChange={(e) => setFilter({ ...filter, spaceId: e.target.value || null })}>
              <option value="">All spaces</option>
              {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <select aria-label="Priority" className={SELECT} value={filter.priority ?? ''} onChange={(e) => setFilter({ ...filter, priority: e.target.value || null })}>
            <option value="">Any priority</option>
            {['urgent', 'high', 'normal', 'low'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <input aria-label="Search" placeholder="Search" className={cn(SELECT, 'min-w-40 flex-1')} value={filter.words} onChange={(e) => setFilter({ ...filter, words: e.target.value })} />
        </div>

        {error && <p className="mt-4 text-sm text-destructive">Tasks could not be loaded: {error}</p>}
        {leadError && <p role="alert" className="mt-4 text-sm text-destructive">The project lead could not open: {leadError}</p>}

        {overview && tab === 'open' && (
          <>
            <Group title="Your turn" hint="a session or step waits for you" items={yourTurn} tone="you" onOpen={openTask} />
            <Group title="Running" hint="a session works on it now" items={running} tone="running" onOpen={openTask} />
            <Group title="Due" hint="today or earlier" items={due} tone="active" onOpen={openTask} />

            <h2 className="mt-8 text-sm font-semibold text-foreground">Projects · {activeGroups.length}</h2>
            <p className="text-xs text-muted-foreground">Something waits, runs, is due, or changed in the last 7 days.</p>
            {activeGroups.map((g) => <ProjectCard key={g.key} group={g} today={today} onOpen={openTask} onWork={workOnToday} />)}

            {quietGroups.length > 0 && (
              <section className="mt-6">
                <button type="button" onClick={() => setShowQuiet(!showQuiet)} className="flex items-baseline gap-2 text-left">
                  {showQuiet ? <ChevronDown className="h-3.5 w-3.5 self-center text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 self-center text-muted-foreground" />}
                  <h2 className="text-sm font-semibold text-foreground">Quiet · {quietGroups.length}</h2>
                  <span className="text-xs text-muted-foreground">nothing moved in 7 days</span>
                </button>
                {showQuiet && quietGroups.map((g) => <ProjectCard key={g.key} group={g} today={today} onOpen={openTask} onWork={workOnToday} folded />)}
              </section>
            )}
          </>
        )}
        {tab === 'triage' && <TriageView items={triage.items} reload={triage.reload} />}
        {overview && tab === 'done' && (
          <Group title="Done" hint="closed in the last 7 days" items={keep(overview.done)} tone="done" onOpen={openTask} />
        )}
      </div>
    </div>
    {selected && (
      <TaskWorkspace key={`${selected.spaceId}:${selected.id}`} task={selected} steps={steps} sessions={sessions ?? []} spaces={spaces} projects={cockpitProjects} onClose={() => setSelected(null)} />
    )}
    </div>
  );
}

/** A project with its open tasks: what waits, runs and is due, and the way into today's work on it. */
function ProjectCard({ group, today, onOpen, onWork, folded = false }: {
  group: ProjectGroup; today: string; onOpen: (task: OverviewTask) => void; onWork: (group: ProjectGroup) => void; folded?: boolean;
}) {
  const [open, setOpen] = useState(!folded);
  const [all, setAll] = useState(false);
  const shown = all ? group.items : group.items.slice(0, 5);
  const counts = [
    group.waiting > 0 && <span key="w" className="text-primary">{group.waiting} your turn</span>,
    group.running > 0 && <span key="r">{group.running} running</span>,
    group.due > 0 && <span key="d">{group.due} due</span>,
    <span key="o">{group.items.length} open</span>,
  ].filter(Boolean);
  return (
    <section className="mt-3 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-3 bg-muted/30 px-3 py-2">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-baseline gap-2 text-left" aria-expanded={open}>
          {open ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 self-center text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 self-center text-muted-foreground" />}
          <span className="truncate text-sm font-semibold text-foreground">{group.name}</span>
          <span className="flex-shrink-0 text-xs text-muted-foreground">{group.spaceName}</span>
          <span className="flex min-w-0 gap-2 truncate text-xs text-muted-foreground">{counts.flatMap((c, i) => (i > 0 ? [<span key={`s${i}`}>·</span>, c] : [c]))}</span>
        </button>
        {group.brainId && (
          <button type="button" onClick={() => onWork(group)} title="Open the project's desk with today's project lead"
            className="flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent">
            <Play className="h-3 w-3" /> Work on it today
          </button>
        )}
      </div>
      {open && (
        <ul className="divide-y divide-border border-t border-border">
          {shown.map((item) => (
            <TaskRow key={item.task.id} item={item} tone={item.waiting ? 'you' : item.running ? 'running' : isDue(item.task, today) || item.task.status === 'active' ? 'active' : 'planned'} onOpen={onOpen} />
          ))}
          {group.items.length > shown.length && (
            <li><button type="button" onClick={() => setAll(true)} className="w-full px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground">Show all {group.items.length}</button></li>
          )}
        </ul>
      )}
    </section>
  );
}

type Tone = 'you' | 'running' | 'active' | 'planned' | 'done';
const DOT: Record<Tone, string> = {
  you: 'bg-primary', running: 'bg-success', active: 'bg-foreground/50', planned: 'bg-foreground/20', done: 'bg-foreground/20',
};

function Group({ title, hint, items, tone, onOpen, folded = false }: {
  title: string; hint: string; items: OverviewItem[]; tone: Tone; onOpen: (task: OverviewTask) => void; folded?: boolean;
}) {
  const [open, setOpen] = useState(!folded);
  if (items.length === 0) return null;
  return (
    <section className="mt-6">
      <button type="button" onClick={() => setOpen(!open)} className="mb-2 flex items-baseline gap-2 text-left">
        {open ? <ChevronDown className="h-3.5 w-3.5 self-center text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 self-center text-muted-foreground" />}
        <h2 className={cn('text-sm font-semibold', tone === 'you' ? 'text-primary' : 'text-foreground')}>{title} · {items.length}</h2>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </button>
      {open && (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {items.map((item) => <TaskRow key={`${item.task.spaceId}:${item.task.id}`} item={item} tone={tone} onOpen={onOpen} />)}
        </ul>
      )}
    </section>
  );
}

function TaskRow({ item, tone, onOpen }: { item: OverviewItem; tone: Tone; onOpen: (task: OverviewTask) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { task, steps } = item;
  const meta = [task.project, task.priority && task.priority !== 'normal' ? task.priority : null, task.stage].filter(Boolean).join(' · ');
  const line = item.waiting
    ? `${item.waiting.stepTitle ? `${item.waiting.stepTitle}: ` : ''}${item.waiting.why}`
    : item.running ? `${item.running.title === task.title ? 'working' : `step: ${item.running.title}`} · ${item.running.sessionName}`
    : item.jobs.length > 0 ? `${item.jobs.length} job${item.jobs.length === 1 ? '' : 's'} attached`
    : null;
  const age = item.waiting?.since || task.updatedAt;
  return (
    <li className="bg-background">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', DOT[tone])} />
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => onOpen(task)} className="block max-w-full truncate text-left text-sm text-foreground hover:underline">{task.title}</button>
          <p className="truncate text-xs text-muted-foreground">{[meta, task.spaceName].filter(Boolean).join(' · ')}</p>
          {line && <p className={cn('truncate text-xs', tone === 'you' ? 'text-primary' : 'text-muted-foreground')} title={line}>{line}</p>}
        </div>
        {steps.length > 0 && (
          <button type="button" onClick={() => setExpanded(!expanded)} className="flex flex-shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground" aria-expanded={expanded}>
            {item.done} of {steps.length}
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        )}
        <span className="w-20 flex-shrink-0 text-right text-[11px] text-muted-foreground">{formatAgo(age)}</span>
      </div>
      {expanded && <Plan steps={steps} onOpen={onOpen} />}
    </li>
  );
}

/** The steps of a task: what each one waits for, its checkpoint, whose turn it is. */
function Plan({ steps, onOpen }: { steps: OverviewTask[]; onOpen: (task: OverviewTask) => void }) {
  const order = { active: 0, planned: 1, resolved: 2 } as Record<string, number>;
  const sorted = [...steps].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
  const title = (id: string) => steps.find((s) => s.id === id)?.title ?? null;
  return (
    <ul className="border-t border-border bg-muted/30 py-1 pl-8 pr-3">
      {sorted.map((step) => {
        const waitsFor = step.dependsOn.filter((id) => steps.find((s) => s.id === id)?.status !== 'resolved').map(title).filter(Boolean);
        const facts = [
          step.waitingOn ? `${step.waitingOn.who}'s turn: ${step.waitingOn.why}` : null,
          step.status !== 'resolved' && waitsFor.length > 0 ? `after ${waitsFor.join(', ')}` : null,
          step.checkpoint === 'before' ? 'go first' : step.checkpoint === 'after' ? 'review after' : null,
        ].filter(Boolean).join(' · ');
        return (
          <li key={step.id} className="flex items-baseline gap-2 py-1">
            <span className={cn('w-16 flex-shrink-0 text-[11px]', step.status === 'resolved' ? 'text-muted-foreground line-through' : step.status === 'active' ? 'text-foreground' : 'text-muted-foreground')}>{step.status}</span>
            <button type="button" onClick={() => onOpen(step)} className={cn('min-w-0 truncate text-left text-xs hover:underline', step.status === 'resolved' ? 'text-muted-foreground' : 'text-foreground')}>{step.title}</button>
            {facts && <span className={cn('min-w-0 truncate text-[11px]', step.waitingOn ? 'text-primary' : 'text-muted-foreground')}>{facts}</span>}
          </li>
        );
      })}
    </ul>
  );
}
