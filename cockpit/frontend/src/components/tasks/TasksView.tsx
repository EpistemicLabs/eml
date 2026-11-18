// The Tasks tab, organised like Linear (decision cockpit-task-views-follow-linear-model):
// Inbox (what needs the user), My tasks (Linear's Focus order with the week's
// cycle), Triage (tasks sessions made on their own, before they reach the brain),
// Projects (one row each, the way into its lead) and Cycles (this week's
// commitment and the planner). Scheduled jobs live in Jobs. The views read;
// tasks change through the agents, except triage's and the Inbox's own taps.
// A click on a task opens its panel with its session's chat (TaskWorkspace).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Play } from 'lucide-react';

import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { allSessionState, sessionMark, MARK_WORD, type AllSession } from '@/components/sidebar/allSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import { formatAgo } from '@/components/jobs/jobs';
import { SessionView, TaskWorkspace } from '@/components/tasks/TaskWorkspace';
import { TriageView, useTriage } from '@/components/tasks/TriageView';
import { openCyclePlanner, openProjectLead, projectIdOfBrain } from '@/lib/project-lead';
import { clearSession } from '@/lib/session-actions';
import { SPACE_HEADER } from '@/lib/space-header';
import {
  agentTasks, buildOverview, readableTitle, carried, cycleProgress, focusGroups, groupByProject, matches, toOverviewTask,
  type AgentReason, type OverviewFilter, type OverviewItem, type OverviewTask, type ProjectGroup, type RawTask, type TaskJob, type TaskSession,
} from '@/lib/tasks-overview';
import { formatWhen } from '@/components/jobs/jobs';
import { api } from '@/utils/api';
import { cn } from '@/lib/utils';
import { getActiveSpaceId } from '@/stores/usePaneStore';
import { paneSpaceKey, switchSpace, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import { useTurnStore } from '@/stores/useTurnStateStore';
import type { Project } from '@/types/app';

type Loaded = { open: OverviewTask[]; resolved: OverviewTask[] };
type Cycle = { id: string; week: number; from: string; to: string };
type View = 'inbox' | 'mine' | 'agents' | 'triage' | 'projects' | 'cycles';
/** What an agent on the task is doing, from its sessions. */
export type AgentState = 'needs input' | 'error' | 'working' | 'done';

async function brainList<T>(space: SpaceInfo, path: string): Promise<T> {
  // Always named: without it the page's fetch would send the active space, and Main would list another space's tasks.
  const res = await fetch(`/api/brain${path}`, { headers: { Accept: 'application/json', [SPACE_HEADER]: space.id } });
  if (!res.ok) throw new Error(`${space.name}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function loadJobs(): Promise<TaskJob[]> {
  const res = await api.jobs().catch(() => null);
  if (!res?.ok) return [];
  const body = await res.json() as { jobs: Array<{ id: string; name: string; taskId?: string | null; nextRuns: string[]; paused: boolean; endedAt: string | null }> };
  return body.jobs.map((j) => ({ id: j.id, name: j.name, taskId: j.taskId ?? null, nextRun: j.nextRuns[0] ?? null, paused: j.paused, ended: j.endedAt !== null }));
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

const VIEW_KEY = 'cockpit-tasks-view';
const FILTER_KEY = 'cockpit-tasks-filter';
const FOLDS_KEY = 'cockpit-tasks-folds';
const NO_FILTER: OverviewFilter = { spaceId: null, project: null, priority: null, words: '' };

/** Per-browser settings of the view; the page works without them (private windows, blocked storage). */
function remembered<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) } as T : fallback; } catch { return fallback; }
}
function remember(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* per-viewer only */ }
}

/** Whether a group is open, remembered per group title; `fallback` until the user folds or opens it. */
function useFold(title: string, fallback: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => remembered<Record<string, boolean>>(FOLDS_KEY, {})[title] ?? fallback);
  const set = (next: boolean) => { setOpen(next); remember(FOLDS_KEY, { ...remembered<Record<string, boolean>>(FOLDS_KEY, {}), [title]: next }); };
  return [open, set];
}
const readView = (): View => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'inbox' || v === 'mine' || v === 'agents' || v === 'triage' || v === 'projects' || v === 'cycles' ? v : 'mine';
  } catch { return 'mine'; }
};

/** The Inbox: sessions that need the user, without the snoozed ones. */
export function inboxItems(sessions: AllSession[], turns: Record<string, { state: string; since: string } | undefined>, now: Date): AllSession[] {
  return sessions
    .filter((s) => !s.archivedAt && !(s.snoozedUntil && Date.parse(s.snoozedUntil) > now.getTime()))
    .filter((s) => { const mark = sessionMark(s, turns[s.id] as never); return mark === 'question' || mark === 'failed' || mark === 'waiting' || mark === 'review'; })
    .sort((a, b) => String(a.attention?.at ?? '').localeCompare(String(b.attention?.at ?? '')));
}

/** Per task, what its sessions' agents are doing: needs input before error before working before done. */
export function agentStates(sessions: AllSession[], turns: Record<string, { state: string; since: string } | undefined>): Map<string, AgentState> {
  const order: AgentState[] = ['needs input', 'error', 'working', 'done'];
  const states = new Map<string, AgentState>();
  for (const s of sessions) {
    if (!s.taskId || s.archivedAt) continue;
    const mark = sessionMark(s, turns[s.id] as never);
    const state: AgentState | null = mark === 'question' || mark === 'waiting' ? 'needs input'
      : mark === 'failed' ? 'error'
      : allSessionState(s, turns[s.id] as never) === 'working' ? 'working'
      : s.attention?.kind === 'done' ? 'done' : null;
    if (!state) continue;
    const had = states.get(s.taskId);
    if (!had || order.indexOf(state) < order.indexOf(had)) states.set(s.taskId, state);
  }
  return states;
}

const SELECT = 'h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground';

export default function TasksView({ projects: cockpitProjects }: { projects?: Project[] }) {
  const spaces = useSpaces();
  const { sessions, refresh } = useAllSessions(true);
  const { turns } = useTurnStore();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer only */ } };
  const [filter, setFilterState] = useState<OverviewFilter>(() => remembered(FILTER_KEY, NO_FILTER));
  const setFilter = (next: OverviewFilter) => { setFilterState(next); remember(FILTER_KEY, next); };
  const [cycle, setCycle] = useState<{ current: Cycle; next: Cycle } | null>(null);
  const [jobs, setJobs] = useState<TaskJob[]>([]);
  const [leadError, setLeadError] = useState<string | null>(null);
  const triage = useTriage();

  const load = useCallback(async () => {
    try {
      const [perSpace, jobList] = await Promise.all([Promise.all(spaces.map(loadSpace)), loadJobs()]);
      setLoaded({ open: perSpace.flatMap((s) => s.open), resolved: perSpace.flatMap((s) => s.resolved) });
      setJobs(jobList);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load the tasks');
    }
  }, [spaces]);

  useEffect(() => {
    if (spaces.length === 0) return;
    void load();
    void fetch('/api/cycles').then((r) => (r.ok ? r.json() : null)).then((c) => c && setCycle(c)).catch(() => {});
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load, spaces.length]);

  const all = useMemo(() => sessions ?? [], [sessions]);
  const taskSessions = useMemo<TaskSession[]>(() => all
    .filter((s) => s.taskId && !s.archivedAt)
    .map((s) => ({ taskId: s.taskId!, sessionId: s.id, name: sessionDisplayName(s), working: allSessionState(s, turns[s.id]) === 'working' })), [all, turns]);
  const agents = useMemo(() => agentStates(all, turns as never), [all, turns]);
  const overview = useMemo(() => loaded && buildOverview({ ...loaded, jobs: [], sessions: taskSessions, now: new Date() }), [loaded, taskSessions]);
  const keep = (items: OverviewItem[]) => items.filter((i) => matches(i.task, filter));
  const inbox = useMemo(() => inboxItems(all, turns as never, new Date()), [all, turns]);
  // Tasks handled by agents (Linear's delegate): shown in Agents; in My tasks only while they need the user.
  const agentReasons = useMemo(() => agentTasks({
    tasks: [...(loaded?.open ?? []), ...(loaded?.resolved ?? [])],
    jobs,
    agentSessions: all.filter((s) => s.worker && s.taskId && !s.archivedAt).map((s) => ({ taskId: s.taskId!, working: allSessionState(s, turns[s.id]) === 'working' })),
    agents: spaces.map((s) => s.agent).filter((a): a is string => Boolean(a)),
  }), [loaded, jobs, all, turns, spaces]);

  const [selected, setSelected] = useState<{ task: OverviewTask; sessionId?: string } | null>(null);
  const [loose, setLoose] = useState<AllSession | null>(null);
  const openTask = (task: OverviewTask, sessionId?: string) => {
    const space = spaces.find((s) => s.id === task.spaceId);
    // The panel reads the active space's brain: a task of another space opens there.
    if (space && paneSpaceKey(space) !== getActiveSpaceId()) switchSpace(space);
    setLoose(null);
    setSelected({ task, sessionId });
  };
  const openInboxItem = (session: AllSession) => {
    const task = loaded?.open.find((t) => t.id === session.taskId && t.spaceId === session.spaceId);
    if (task) openTask(task, session.id);
    else { setSelected(null); setLoose(session); }
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
    return [...loaded.open, ...loaded.resolved].filter((t) => t.parentId === selected.task.id && t.spaceId === selected.task.spaceId);
  }, [selected, loaded]);

  const narrow = Boolean(selected || loose);
  const nav: Array<{ id: View; label: string; count?: number; hot?: boolean }> = [
    { id: 'inbox', label: 'Inbox', count: inbox.length, hot: inbox.length > 0 },
    { id: 'mine', label: 'My tasks' },
    { id: 'agents', label: 'Agents' },
    { id: 'triage', label: 'Triage', count: triage.items.length, hot: triage.items.length > 0 },
    { id: 'projects', label: 'Projects' },
    { id: 'cycles', label: 'Cycles' },
  ];

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Task views" className="hidden w-44 flex-shrink-0 flex-col gap-0.5 border-r border-border p-2 md:flex">
        {nav.map((n) => (
          <button key={n.id} type="button" onClick={() => setView(n.id)} aria-current={view === n.id ? 'page' : undefined}
            className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm', view === n.id ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
            {n.label}
            {n.count !== undefined && n.count > 0 && <span className={cn('ml-auto text-xs', n.hot ? 'text-primary' : 'text-muted-foreground')}>{n.count}</span>}
          </button>
        ))}
      </nav>
      <div className={cn('flex min-h-0 flex-col overflow-y-auto py-5', narrow ? 'w-[26rem] flex-shrink-0 px-4' : 'flex-1 px-6')}>
        <div className={cn('w-full', !narrow && 'mx-auto max-w-4xl')}>
          <div className="mb-3 flex gap-1 overflow-x-auto md:hidden">
            {nav.map((n) => (
              <button key={n.id} type="button" onClick={() => setView(n.id)} className={cn('rounded px-2 py-1 text-sm', view === n.id ? 'bg-accent text-foreground' : 'text-muted-foreground')}>{n.label}</button>
            ))}
          </div>
          {(view === 'mine' || view === 'agents' || view === 'projects' || view === 'cycles') && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
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
          )}
          {error && <p className="mb-4 text-sm text-destructive">Tasks could not be loaded: {error}</p>}
          {leadError && <p role="alert" className="mb-4 text-sm text-destructive">The session could not open: {leadError}</p>}

          {view === 'inbox' && <InboxView items={inbox} tasks={loaded?.open ?? []} onOpen={openInboxItem} onChanged={refresh} />}
          {view === 'mine' && overview && (
            <MyTasks overview={overview} loaded={loaded!} cycle={cycle?.current ?? null} keep={keep} agents={agents} agentReasons={agentReasons} onOpen={openTask} onAgents={() => setView('agents')} />
          )}
          {view === 'agents' && overview && loaded && (
            <AgentsView overview={overview} loaded={loaded} jobs={jobs} agentReasons={agentReasons} agents={agents} keep={keep} onOpen={openTask} />
          )}
          {view === 'triage' && <TriageView items={triage.items} reload={triage.reload} />}
          {view === 'projects' && overview && (
            <ProjectsView groups={groupByProject(overview, new Date()).map((g) => ({ ...g, items: keep(g.items) })).filter((g) => g.items.length > 0)}
              cycleId={cycle?.current.id ?? null} agents={agents} onOpen={openTask} onWork={workOnToday} />
          )}
          {view === 'cycles' && loaded && cycle && (
            <CyclesView loaded={loaded} cycle={cycle} keep={(ts) => ts.filter((t) => matches(t, filter))} spaces={spaces} projects={cockpitProjects ?? []}
              onOpen={(t) => openTask(t)} onPlanner={(problem) => setLeadError(problem)} />
          )}
        </div>
      </div>
      {selected && (
        <TaskWorkspace key={`${selected.task.spaceId}:${selected.task.id}:${selected.sessionId ?? ''}`} task={selected.task} sessionId={selected.sessionId} steps={steps} sessions={all} spaces={spaces} projects={cockpitProjects} onClose={() => setSelected(null)} />
      )}
      {loose && !selected && (
        <section aria-label="Session" className="flex min-w-0 flex-1 flex-col border-l border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-muted-foreground">
            <span className="truncate">{sessionDisplayName(loose)} · no task</span>
            <button type="button" onClick={() => setLoose(null)} className="rounded px-2 py-1 hover:bg-accent">Close</button>
          </div>
          <SessionView session={loose} space={spaces.find((s) => s.id === loose.spaceId)} />
        </section>
      )}
    </div>
  );
}

/** What agents work on: needs you, running now, scheduled, waiting for their turn, done recently. */
function AgentsView({ overview, loaded, jobs, agentReasons, agents, keep, onOpen }: {
  overview: NonNullable<ReturnType<typeof buildOverview>>; loaded: Loaded; jobs: TaskJob[]; agentReasons: Map<string, AgentReason>;
  agents: Map<string, AgentState>; keep: (items: OverviewItem[]) => OverviewItem[]; onOpen: (task: OverviewTask) => void;
}) {
  const open = [...overview.yourTurn, ...overview.running, ...overview.active, ...overview.planned];
  const isAgent = (i: OverviewItem) => agentReasons.has(i.task.id) || i.steps.some((s) => agentReasons.has(s.id));
  const theirs = keep(open.filter(isAgent));
  const stateOf = (i: OverviewItem) => [i.task, ...i.steps].map((t) => agents.get(t.id)).find(Boolean);
  const needsYou = theirs.filter((i) => { const s = stateOf(i); return s === 'needs input' || s === 'error'; });
  const rest = theirs.filter((i) => !needsYou.includes(i));
  const running = rest.filter((i) => i.running || stateOf(i) === 'working');
  const idle = rest.filter((i) => !running.includes(i));
  const scheduled = idle.filter((i) => agentReasons.get(i.task.id) === 'scheduled');
  const waiting = idle.filter((i) => !scheduled.includes(i));
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const done = keep(overview.done.filter((i) => agentReasons.has(i.task.id) && Date.parse(i.task.updatedAt) > weekAgo));
  const nextRun = (taskId: string) => jobs.filter((j) => j.taskId === taskId && !j.ended).sort((a, b) => (a.nextRun ?? '9').localeCompare(b.nextRun ?? '9'))[0];
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">Agents</h2>
      <p className="mt-1 text-sm text-muted-foreground">Tasks agents work on for you: running, scheduled, or waiting for their turn. You stay the owner; what needs you is also in the Inbox.</p>
      <Group title="Needs you" hint="also in the Inbox; answer in the session's chat" items={needsYou} tone="you" agents={agents} onOpen={onOpen} />
      <Group title="Running now" hint="an agent works on it" items={running} tone="running" agents={agents} onOpen={onOpen} />
      {scheduled.length > 0 && (
        <section className="mt-6">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Scheduled · {scheduled.length} <span className="text-xs font-normal text-muted-foreground">next run first; the schedules are managed in Jobs</span></h3>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {[...scheduled].sort((a, b) => (nextRun(a.task.id)?.nextRun ?? '9').localeCompare(nextRun(b.task.id)?.nextRun ?? '9')).map((i) => {
              const job = nextRun(i.task.id);
              return (
                <li key={`${i.task.spaceId}:${i.task.id}`} className="flex items-start gap-3 bg-background px-3 py-2.5">
                  <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full border border-foreground/40" />
                  <div className="min-w-0 flex-1">
                    <button type="button" onClick={() => onOpen(i.task)} className="block max-w-full truncate text-left text-sm text-foreground hover:underline" title={i.task.title}>{readableTitle(i.task.title)}</button>
                    <p className="truncate text-xs text-muted-foreground">{[job?.name, i.task.project].filter(Boolean).join(' · ')}</p>
                  </div>
                  <span className="flex-shrink-0 text-[11px] text-muted-foreground">{job?.paused ? 'paused' : job?.nextRun ? formatWhen(job.nextRun) : 'no next run'}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <Group title="Waiting for their turn" hint="planned steps the runner starts, and tasks assigned to an agent" items={waiting} tone="planned" agents={agents} onOpen={onOpen} />
      <Group title="Done · 7 days" hint="what agents finished" items={done} tone="done" agents={agents} onOpen={onOpen} folded />
      {theirs.length === 0 && done.length === 0 && <p className="mt-6 text-sm text-muted-foreground">No agent works on a task right now.</p>}
    </section>
  );
}

/** The next morning at 9, and the next Monday at 9, in this browser's zone. */
export function snoozeTimes(now: Date): { tomorrow: string; monday: string } {
  const at9 = (d: Date) => { const x = new Date(d); x.setHours(9, 0, 0, 0); return x; };
  const tomorrow = at9(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const monday = at9(new Date(now.getTime() + (((8 - now.getDay()) % 7) || 7) * 24 * 60 * 60 * 1000));
  return { tomorrow: tomorrow.toISOString(), monday: monday.toISOString() };
}

function InboxView({ items, tasks, onOpen, onChanged }: {
  items: AllSession[]; tasks: OverviewTask[]; onOpen: (s: AllSession) => void; onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const done = async (s: AllSession) => { setBusy(s.id); await clearSession(s.id); setBusy(null); await onChanged(); };
  const snooze = async (s: AllSession, until: string) => {
    setBusy(s.id);
    await fetch(`/api/sessions/${encodeURIComponent(s.id)}/snooze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ until }) }).catch(() => null);
    setBusy(null);
    await onChanged();
  };
  const times = snoozeTimes(new Date());
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">Inbox</h2>
      <p className="mt-1 text-sm text-muted-foreground">What needs you: a question, a go, a review, a session that failed. Answer in its chat.</p>
      {items.length === 0 ? <p className="mt-6 text-sm text-muted-foreground">Nothing needs you right now.</p> : (
        <ul className="mt-4 divide-y divide-border overflow-hidden rounded-lg border border-border">
          {items.map((s) => {
            const task = tasks.find((t) => t.id === s.taskId);
            const mark = s.attention?.kind === 'failed' ? 'failed' : s.attention?.kind === 'review' ? 'review' : 'question';
            return (
              <li key={s.id} className="flex items-start gap-3 bg-background px-3 py-2.5">
                <span className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', mark === 'failed' ? 'bg-destructive' : 'bg-primary')} />
                <button type="button" onClick={() => onOpen(s)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm text-foreground">{task ? readableTitle(task.title) : sessionDisplayName(s)}</span>
                  <span className="block truncate text-xs text-primary">{s.attention?.reason ?? MARK_WORD[mark]}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{[task?.project, sessionDisplayName(s)].filter(Boolean).join(' · ')}</span>
                </button>
                <span className="flex flex-shrink-0 flex-col items-end gap-1 text-[11px] text-muted-foreground">
                  {s.attention?.at && <span>{formatAgo(s.attention.at)}</span>}
                  <span className="flex gap-1">
                    <button type="button" disabled={busy === s.id} onClick={() => void done(s)} className="rounded border border-border px-1.5 py-0.5 hover:bg-accent" title="Done: it leaves the Inbox">Done</button>
                    <button type="button" disabled={busy === s.id} onClick={() => void snooze(s, times.tomorrow)} className="rounded border border-border px-1.5 py-0.5 hover:bg-accent" title="Back tomorrow at 9:00">Tomorrow</button>
                    <button type="button" disabled={busy === s.id} onClick={() => void snooze(s, times.monday)} className="rounded border border-border px-1.5 py-0.5 hover:bg-accent" title="Back on Monday at 9:00">Monday</button>
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function MyTasks({ overview, loaded, cycle, keep, agents, agentReasons, onOpen, onAgents }: {
  overview: NonNullable<ReturnType<typeof buildOverview>>; loaded: Loaded; cycle: Cycle | null;
  keep: (items: OverviewItem[]) => OverviewItem[]; agents: Map<string, AgentState>; agentReasons: Map<string, AgentReason>;
  onOpen: (task: OverviewTask) => void; onAgents: () => void;
}) {
  const waitsNow = (id: string) => { const state = agents.get(id); return state === 'needs input' || state === 'error'; };
  const all = focusGroups(overview, cycle?.id ?? null, new Date(), waitsNow);
  // An agent's task stays here only while it needs the user (Needs you); otherwise it is in Agents.
  const mine = (items: OverviewItem[]) => keep(items.filter((i) => !agentReasons.has(i.task.id)));
  const focus = { ...all, urgentDue: mine(all.urgentDue), blocking: mine(all.blocking), thisCycle: mine(all.thisCycle), inProgress: mine(all.inProgress), backlog: mine(all.backlog) };
  const handled = [...all.urgentDue, ...all.blocking, ...all.thisCycle, ...all.inProgress, ...all.backlog].filter((i) => agentReasons.has(i.task.id)).length;
  const progress = cycle ? cycleProgress(loaded.open, loaded.resolved, cycle.id) : null;
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">My tasks</h2>
      {cycle && progress && <CycleBar cycle={cycle} progress={progress} />}
      <Group title="Needs you" hint="answer in the session's chat" items={keep(focus.needsYou)} tone="you" agents={agents} onOpen={onOpen} />
      <Group title="Urgent and due" hint="urgent, or due today or earlier" items={focus.urgentDue} tone="active" agents={agents} onOpen={onOpen} />
      <Group title="Blocking others" hint="other tasks wait for these" items={focus.blocking} tone="active" agents={agents} onOpen={onOpen} />
      <Group title="This cycle" hint="this week's commitment" items={focus.thisCycle} tone="planned" agents={agents} onOpen={onOpen} />
      <Group title="In progress" hint="started and touched this week" items={focus.inProgress} tone="running" agents={agents} onOpen={onOpen} />
      <Group title="Backlog" hint="not in this cycle; pulled in at the planning" items={focus.backlog} tone="planned" agents={agents} onOpen={onOpen} folded />
      {handled > 0 && (
        <button type="button" onClick={onAgents} className="mt-6 text-left text-xs text-muted-foreground hover:text-foreground">
          {handled} task{handled === 1 ? '' : 's'} handled by agents · see Agents
        </button>
      )}
      <Group title="Done · 7 days" hint="closed this week and last" items={keep(overview.done)} tone="done" agents={agents} onOpen={onOpen} folded />
    </section>
  );
}

function CycleBar({ cycle, progress }: { cycle: Cycle; progress: { done: number; total: number; inProgress: number } }) {
  const pct = (n: number) => (progress.total ? `${(n / progress.total) * 100}%` : '0%');
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border px-3 py-2 text-sm">
      <span className="font-semibold text-foreground">Cycle {cycle.week}</span>
      <span className="text-muted-foreground">{cycle.from} to {cycle.to}</span>
      <span className="flex h-1.5 min-w-32 flex-1 overflow-hidden rounded-full bg-muted" aria-label={`${progress.done} of ${progress.total} done`}>
        <span className="h-full bg-success" style={{ width: pct(progress.done) }} />
        <span className="h-full bg-warning" style={{ width: pct(progress.inProgress) }} />
      </span>
      <span className="text-muted-foreground">{progress.total === 0 ? 'nothing planned yet' : `${progress.done} of ${progress.total} done`}</span>
    </div>
  );
}

function ProjectsView({ groups, cycleId, agents, onOpen, onWork }: {
  groups: ProjectGroup[]; cycleId: string | null; agents: Map<string, AgentState>; onOpen: (task: OverviewTask) => void; onWork: (g: ProjectGroup) => void;
}) {
  const [showQuiet, setShowQuiet] = useFold('Quiet projects', false);
  const active = groups.filter((g) => g.active);
  const quiet = groups.filter((g) => !g.active);
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">Projects</h2>
      <p className="mt-1 text-sm text-muted-foreground">{active.length} active · {quiet.length} quiet. "Work on it today" opens the project's desk with its lead.</p>
      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-lg border border-border">
        {active.map((g) => <ProjectRow key={g.key} group={g} cycleId={cycleId} agents={agents} onOpen={onOpen} onWork={onWork} />)}
      </ul>
      {quiet.length > 0 && (
        <section className="mt-6">
          <button type="button" onClick={() => setShowQuiet(!showQuiet)} className="flex items-baseline gap-2 text-left">
            {showQuiet ? <ChevronDown className="h-3.5 w-3.5 self-center text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 self-center text-muted-foreground" />}
            <h3 className="text-sm font-semibold text-foreground">Quiet · {quiet.length}</h3>
            <span className="text-xs text-muted-foreground">nothing moved in 7 days</span>
          </button>
          {showQuiet && (
            <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
              {quiet.map((g) => <ProjectRow key={g.key} group={g} cycleId={cycleId} agents={agents} onOpen={onOpen} onWork={onWork} />)}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}

function ProjectRow({ group, cycleId, agents, onOpen, onWork }: {
  group: ProjectGroup; cycleId: string | null; agents: Map<string, AgentState>; onOpen: (task: OverviewTask) => void; onWork: (g: ProjectGroup) => void;
}) {
  const [open, setOpen] = useState(false);
  const inCycle = cycleId ? group.items.filter((i) => i.task.subjects.includes(cycleId)).length : 0;
  return (
    <li className="bg-background">
      <div className="flex items-center gap-3 px-3 py-2">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
          {open ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 self-center text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 self-center text-muted-foreground" />}
          <span className="truncate text-sm font-medium text-foreground">{group.name}</span>
          <span className="flex-shrink-0 text-xs text-muted-foreground">{group.spaceName}</span>
        </button>
        <span className="flex flex-shrink-0 gap-2 text-xs text-muted-foreground">
          {group.waiting > 0 && <span className="text-primary">{group.waiting} need you</span>}
          {inCycle > 0 && <span>{inCycle} this cycle</span>}
          <span>{group.items.length} open</span>
        </span>
        {group.brainId && (
          <button type="button" onClick={() => onWork(group)} title="Open the project's desk with today's project lead"
            className="flex flex-shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent">
            <Play className="h-3 w-3" /> Work on it today
          </button>
        )}
      </div>
      {open && (
        <ul className="divide-y divide-border border-t border-border">
          {group.items.map((item) => <TaskRow key={item.task.id} item={item} tone={item.waiting ? 'you' : item.running ? 'running' : 'planned'} agent={agents.get(item.task.id)} onOpen={onOpen} />)}
        </ul>
      )}
    </li>
  );
}

function CyclesView({ loaded, cycle, keep, spaces, projects, onOpen, onPlanner }: {
  loaded: Loaded; cycle: { current: Cycle; next: Cycle }; keep: (ts: OverviewTask[]) => OverviewTask[]; spaces: SpaceInfo[];
  projects: Project[]; onOpen: (t: OverviewTask) => void; onPlanner: (problem: string | null) => void;
}) {
  const tasksOf = (id: string) => ({
    open: keep(loaded.open.filter((t) => t.subjects.includes(id))),
    done: keep(loaded.resolved.filter((t) => t.subjects.includes(id))),
  });
  const now = tasksOf(cycle.current.id);
  const next = tasksOf(cycle.next.id);
  const progress = cycleProgress(loaded.open, loaded.resolved, cycle.current.id);
  const plan = () => {
    const space = spaces.find((s) => s.main) ?? spaces[0];
    if (!space) return;
    onPlanner(null);
    void openCyclePlanner(space).then(onPlanner);
  };
  const row = (t: OverviewTask) => (
    <li key={`${t.spaceId}:${t.id}`} className="flex items-baseline gap-3 bg-background px-3 py-2">
      <span className={cn('w-16 flex-shrink-0 text-[11px]', t.status === 'resolved' ? 'text-muted-foreground line-through' : t.status === 'active' ? 'text-warning' : 'text-muted-foreground')}>{t.status === 'resolved' ? 'done' : t.status === 'active' ? 'in progress' : 'to do'}</span>
      <button type="button" onClick={() => onOpen(t)} className="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:underline" title={t.title}>{readableTitle(t.title)}</button>
      <span className="flex-shrink-0 text-xs text-muted-foreground">{t.project}</span>
      {carried(t) > 0 && <span className="flex-shrink-0 text-xs text-warning">carried {carried(t)}×</span>}
    </li>
  );
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">Cycles</h2>
      <p className="mt-1 text-sm text-muted-foreground">One cycle per week across your projects: what you commit to. Open work rolls into the next cycle on Monday.</p>
      <CycleBar cycle={cycle.current} progress={progress} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={plan} className="flex items-center gap-1 rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:opacity-90">
          <Play className="h-3.5 w-3.5" /> Plan with the planner
        </button>
        <span className="text-xs text-muted-foreground">reads all projects of Main; opens on its own desk</span>
      </div>
      <h3 className="mt-6 text-sm font-semibold text-foreground">This week · {now.open.length + now.done.length}</h3>
      {now.open.length + now.done.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">Nothing planned yet. The planner proposes the week; you agree in its chat.</p> : (
        <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">{[...now.open, ...now.done].map(row)}</ul>
      )}
      <h3 className="mt-6 text-sm font-semibold text-foreground">Next week · {next.open.length}</h3>
      {next.open.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">Nothing yet. Open work from this week rolls in on Monday.</p> : (
        <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">{next.open.map(row)}</ul>
      )}
    </section>
  );
}

type Tone = 'you' | 'running' | 'active' | 'planned' | 'done';
const DOT: Record<Tone, string> = {
  you: 'bg-primary', running: 'bg-success', active: 'bg-foreground/50', planned: 'bg-foreground/20', done: 'bg-foreground/20',
};
const AGENT_STYLE: Record<AgentState, string> = {
  'needs input': 'text-primary', error: 'text-destructive', working: 'text-success', done: 'text-muted-foreground',
};

function Group({ title, hint, items, tone, agents, onOpen, folded = false }: {
  title: string; hint: string; items: OverviewItem[]; tone: Tone; agents: Map<string, AgentState>; onOpen: (task: OverviewTask) => void; folded?: boolean;
}) {
  const [open, setOpen] = useFold(title, !folded);
  if (items.length === 0) return null;
  return (
    <section className="mt-6">
      <button type="button" onClick={() => setOpen(!open)} className="mb-2 flex items-baseline gap-2 text-left">
        {open ? <ChevronDown className="h-3.5 w-3.5 self-center text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 self-center text-muted-foreground" />}
        <h3 className={cn('text-sm font-semibold', tone === 'you' ? 'text-primary' : 'text-foreground')}>{title} · {items.length}</h3>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </button>
      {open && (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {items.map((item) => <TaskRow key={`${item.task.spaceId}:${item.task.id}`} item={item} tone={tone} agent={agents.get(item.task.id)} onOpen={onOpen} />)}
        </ul>
      )}
    </section>
  );
}

function TaskRow({ item, tone, agent, onOpen }: { item: OverviewItem; tone: Tone; agent?: AgentState; onOpen: (task: OverviewTask) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { task, steps } = item;
  const meta = [task.project, task.priority && task.priority !== 'normal' ? task.priority : null, task.stage].filter(Boolean).join(' · ');
  const line = item.waiting
    ? `${item.waiting.stepTitle ? `${item.waiting.stepTitle}: ` : ''}${item.waiting.why}`
    : item.running ? `${item.running.title === task.title ? 'working' : `step: ${item.running.title}`} · ${item.running.sessionName}`
    : null;
  const age = item.waiting?.since || task.updatedAt;
  return (
    <li className="bg-background">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', DOT[tone])} />
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => onOpen(task)} className="block max-w-full truncate text-left text-sm text-foreground hover:underline" title={task.title}>{readableTitle(task.title)}</button>
          <p className="truncate text-xs text-muted-foreground">{[meta, task.spaceName].filter(Boolean).join(' · ')}</p>
          {line && <p className={cn('truncate text-xs', tone === 'you' ? 'text-primary' : 'text-muted-foreground')} title={line}>{line}</p>}
        </div>
        {agent && <span className={cn('flex-shrink-0 text-[11px]', AGENT_STYLE[agent])}>agent {agent}</span>}
        {carried(task) > 0 && <span className="flex-shrink-0 text-[11px] text-warning">carried {carried(task)}×</span>}
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
            <button type="button" onClick={() => onOpen(step)} className={cn('min-w-0 truncate text-left text-xs hover:underline', step.status === 'resolved' ? 'text-muted-foreground' : 'text-foreground')} title={step.title}>{readableTitle(step.title)}</button>
            {facts && <span className={cn('min-w-0 truncate text-[11px]', step.waitingOn ? 'text-primary' : 'text-muted-foreground')}>{facts}</span>}
          </li>
        );
      })}
    </ul>
  );
}
