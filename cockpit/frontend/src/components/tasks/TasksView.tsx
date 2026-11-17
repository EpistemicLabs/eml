// The Tasks view (header › Tasks): every open brain task of every space, in the
// order the user works through them (lib/tasks-overview.ts). It only reads:
// tasks change through the agents. A click on a task opens its panel, the one
// the Brain tab uses; a task with steps unfolds its plan in place.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { allSessionState } from '@/components/sidebar/allSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import { formatAgo, formatWhen } from '@/components/jobs/jobs';
import { useEngramPanel } from '@/lib/engram-panel';
import { SPACE_HEADER } from '@/lib/space-header';
import {
  buildOverview, matches, toOverviewTask,
  type OverviewFilter, type OverviewItem, type OverviewTask, type RawTask, type TaskJob, type TaskSession,
} from '@/lib/tasks-overview';
import { cn } from '@/lib/utils';
import { getActiveSpaceId } from '@/stores/usePaneStore';
import { paneSpaceKey, switchSpace, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import { useTurnStore } from '@/stores/useTurnStateStore';
import { api } from '@/utils/api';

type Loaded = { open: OverviewTask[]; resolved: OverviewTask[]; jobs: TaskJob[] };

async function brainList<T>(space: SpaceInfo, path: string): Promise<T> {
  const res = await fetch(`/api/brain${path}`, { headers: { Accept: 'application/json', ...(space.main ? {} : { [SPACE_HEADER]: space.id }) } });
  if (!res.ok) throw new Error(`${space.name}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function loadSpace(space: SpaceInfo): Promise<{ open: OverviewTask[]; resolved: OverviewTask[] }> {
  const list = (status: string) => brainList<{ engrams: RawTask[] }>(space, `/list?type=task&status=${status}&with_parent=true&limit=500`)
  const [planned, active, resolved, projects] = await Promise.all([
    list('planned'), list('active'), list('resolved'),
    brainList<{ projects: Array<{ id: string; name: string }> }>(space, '/projects').catch(() => ({ projects: [] })),
  ]);
  const names = new Map(projects.projects.map((p) => [p.id, p.name]));
  const to = (raw: RawTask) => toOverviewTask(raw, space, names);
  return { open: [...planned.engrams, ...active.engrams].map(to), resolved: resolved.engrams.map(to) };
}

async function loadJobs(): Promise<TaskJob[]> {
  const res = await api.jobs();
  if (!res.ok) return [];
  const body = await res.json() as { jobs: Array<{ id: string; name: string; taskId?: string | null; nextRuns: string[]; paused: boolean; endedAt: string | null }> };
  return body.jobs.map((job) => ({ id: job.id, name: job.name, taskId: job.taskId ?? null, nextRun: job.nextRuns[0] ?? null, paused: job.paused, ended: job.endedAt !== null }));
}

const SELECT = 'h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground';

export default function TasksView() {
  const spaces = useSpaces();
  const { sessions } = useAllSessions(true);
  const { turns } = useTurnStore();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const [filter, setFilter] = useState<OverviewFilter>({ spaceId: null, project: null, priority: null, words: '' });

  const load = useCallback(async () => {
    try {
      const [perSpace, jobs] = await Promise.all([Promise.all(spaces.map(loadSpace)), loadJobs()]);
      setLoaded({ open: perSpace.flatMap((s) => s.open), resolved: perSpace.flatMap((s) => s.resolved), jobs });
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

  const overview = useMemo(() => loaded && buildOverview({ ...loaded, sessions: taskSessions, now: new Date() }), [loaded, taskSessions]);
  const keep = (items: OverviewItem[]) => items.filter((i) => matches(i.task, filter));
  const projects = useMemo(() => [...new Set((loaded?.open ?? []).map((t) => t.project).filter((p): p is string => !!p))].sort(), [loaded]);

  const { go } = useEngramPanel();
  const openTask = (task: OverviewTask) => {
    const space = spaces.find((s) => s.id === task.spaceId);
    // The panel reads the active space's brain: a task of another space opens there.
    if (space && paneSpaceKey(space) !== getActiveSpaceId()) switchSpace(space);
    go(task.id);
  };

  const yourTurn = overview ? keep(overview.yourTurn) : [];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5">
      <div className="mx-auto w-full max-w-4xl">
        <h1 className="text-lg font-semibold text-foreground">Tasks</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {overview ? `${overview.openCount} open tasks across spaces, your turn first` : 'Loading…'}
          {yourTurn.length > 0 && <span className="text-primary"> · {yourTurn.length} need{yourTurn.length === 1 ? 's' : ''} you</span>}
          <span className="block text-xs">Sorted by priority, then waiting time. The view only reads: ask an agent to change a task.</span>
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5">
            {(['open', 'done'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)}
                className={cn('rounded px-2.5 py-1 text-sm', tab === t ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {t === 'open' ? 'Open' : 'Done · 7 days'}
              </button>
            ))}
          </div>
          {spaces.length > 1 && (
            <select aria-label="Space" className={SELECT} value={filter.spaceId ?? ''} onChange={(e) => setFilter({ ...filter, spaceId: e.target.value || null })}>
              <option value="">All spaces</option>
              {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <select aria-label="Project" className={SELECT} value={filter.project ?? ''} onChange={(e) => setFilter({ ...filter, project: e.target.value || null })}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select aria-label="Priority" className={SELECT} value={filter.priority ?? ''} onChange={(e) => setFilter({ ...filter, priority: e.target.value || null })}>
            <option value="">Any priority</option>
            {['urgent', 'high', 'normal', 'low'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <input aria-label="Search" placeholder="Search" className={cn(SELECT, 'min-w-40 flex-1')} value={filter.words} onChange={(e) => setFilter({ ...filter, words: e.target.value })} />
        </div>

        {error && <p className="mt-4 text-sm text-destructive">Tasks could not be loaded: {error}</p>}

        {overview && tab === 'open' && (
          <>
            <Group title="Your turn" hint="a session or step waits for you" items={yourTurn} tone="you" onOpen={openTask} />
            <Group title="Running" hint="a session works on it now" items={keep(overview.running)} tone="running" onOpen={openTask} />
            <Scheduled rows={overview.scheduled.filter((r) => !r.item || matches(r.item.task, filter))} onOpen={openTask} />
            <Group title="Active" hint="started, nobody on it right now" items={keep(overview.active)} tone="active" onOpen={openTask} />
            <Group title="Planned" hint="not started" items={keep(overview.planned)} tone="planned" onOpen={openTask} folded />
          </>
        )}
        {overview && tab === 'done' && (
          <Group title="Done" hint="closed in the last 7 days" items={keep(overview.done)} tone="done" onOpen={openTask} />
        )}
      </div>
    </div>
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

function Scheduled({ rows, onOpen }: { rows: Array<{ job: TaskJob; item: OverviewItem | null }>; onOpen: (task: OverviewTask) => void }) {
  if (rows.length === 0) return null;
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-foreground">Scheduled · {rows.length}</h2>
        <span className="text-xs text-muted-foreground">jobs, next run first</span>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {rows.map(({ job, item }) => (
          <li key={job.id} className="flex items-start gap-3 bg-background px-3 py-2.5">
            <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full border border-foreground/40" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{job.name}</p>
              {item ? (
                <button type="button" onClick={() => onOpen(item.task)} className="block max-w-full truncate text-left text-xs text-muted-foreground hover:underline">task: {item.task.title}</button>
              ) : (
                <p className="text-xs text-muted-foreground">{job.taskId ? 'task not open' : 'no task'}</p>
              )}
            </div>
            <span className="flex-shrink-0 text-right text-[11px] text-muted-foreground">
              {job.paused ? 'paused' : job.nextRun ? formatWhen(job.nextRun) : 'no next run'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
