// The task board (Inbox · Now · Plan): the host's read model (cockpit/host/src/application/task-board.ts),
// the commands it takes, and the pure helpers the views share. Whose turn a task is comes from the
// host; the page never works it out again, so every count agrees.
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DAY_MS } from '@/lib/time';
import type { Hue } from '@/shared/view/ui/hue';

export type Turn = 'needs_you' | 'review' | 'agent_working' | 'agent_scheduled' | 'waiting_on_others' | 'done';
export type TurnGroup = 'asked' | 'own' | 'parent' | 'nobody' | 'at_time' | 'runner';
export type NobodyReason = 'stopped' | 'no_checkpoint' | 'no_runner' | 'no_owner';
export type CoverageGroup = 'ask' | 'review' | 'due' | 'high' | 'blocked' | 'idle' | 'nofollow' | 'stopped' | 'owner' | 'mine';
export type Coverage =
  | { ok: true; how: 'working' | 'at_time' | 'checks_back' | 'runner'; at?: string }
  | { ok: false; group: CoverageGroup; reason?: NobodyReason | 'parent' | 'steps_wait'; steps?: number };

export interface WaitingOn { who: string; kind?: string; why?: string; since?: string; session_id?: string }

export interface BoardTask {
  id: string;
  spaceId: string;
  spaceName: string;
  project: string | null;
  title: string;
  status: string;
  owner?: string;
  delegate?: string;
  checkpoint?: string;
  priority?: string;
  due?: string;
  parentId: string | null;
  /** The task it was spun off from; missing from an older host. */
  originId?: string | null;
  /** How it hangs in its tree: a sub-task, spun off, or a root. */
  rel?: 'sub' | 'spun' | null;
  waitingOn?: WaitingOn;
  updatedAt: string | null;
  turn: Turn | null;
  group?: TurnGroup;
  reason?: NobodyReason;
  coverage: Coverage;
  urgency: number;
  important: boolean;
  onBoard: boolean;
  sessionIds: string[];
  working: boolean;
  nextRunAt: string | null;
  pending?: { opId: string; kind: string; undoUntil: string };
}

export interface InboxItem {
  key: string;
  kind: 'question' | 'review';
  space: string;
  title: string;
  text: string;
  since: string;
  taskId?: string;
  sessionId?: string;
  until?: string;
}

/** A closed ancestor of a task with a session, which the board's lists leave out (host Board.lineage). */
export interface LineageTask {
  id: string;
  spaceId: string;
  project: string | null;
  title: string;
  status: string;
  parentId: string | null;
  originId: string | null;
}

export interface BoardEvent { at: string; taskId: string; spaceId: string; from: Turn | null; to: Turn | null }

export interface Board {
  at: string;
  viewer: string;
  spaces: Array<{ id: string; name: string; taskSystem: boolean; agents: string[] }>;
  projects: Array<{ spaceId: string; id: string; name: string; goal: string | null }>;
  tasks: BoardTask[];
  /** Missing from an older host. */
  lineage?: LineageTask[];
  inbox: InboxItem[];
  snoozed: InboxItem[];
  events: BoardEvent[];
  counts: { needsYou: number; inbox: number };
}

// ---- data ----

export const BOARD_KEY = ['task-board'] as const;
/** How often the page asks again when no change arrived over the event stream. */
const BOARD_POLL_MS = 20_000;

export async function fetchBoard(): Promise<Board> {
  const res = await fetch('/api/v1/tasks/board', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`The task board did not load (HTTP ${res.status}).`);
  return res.json() as Promise<Board>;
}

/** The board, refreshed when the host reports a change (the `tasks` event) and every 20 s. */
export function useTaskBoard() {
  const client = useQueryClient();
  useEffect(() => {
    const changed = () => { void client.invalidateQueries({ queryKey: BOARD_KEY }); };
    window.addEventListener('cockpit:tasks', changed);
    return () => window.removeEventListener('cockpit:tasks', changed);
  }, [client]);
  return useQuery({ queryKey: BOARD_KEY, queryFn: fetchBoard, refetchInterval: BOARD_POLL_MS });
}

export type CommandAnswer =
  | { ok: true; opId: string; state: string; undoUntil: string; carriedQuestion?: string; brief?: string }
  | { ok: false; code: string; message: string; retry: boolean };

export const newOpId = (): string => crypto.randomUUID();

async function post(path: string, body: unknown): Promise<CommandAnswer> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok) return { ok: true, ...(data as { opId: string; state: string; undoUntil: string }) };
    const error = (data.error ?? {}) as { code?: string; message?: string; retry?: boolean };
    return { ok: false, code: error.code ?? `http_${res.status}`, message: error.message ?? `The cockpit refused (HTTP ${res.status}).`, retry: error.retry ?? res.status >= 500 };
  } catch {
    return { ok: false, code: 'offline', message: 'The cockpit did not answer.', retry: true };
  }
}

export type HandOverMode = 'now' | 'schedule' | 'together';
export interface HandOverInput {
  mode: HandOverMode;
  delegate: string;
  checkpoint: 'before' | 'after' | 'none';
  schedule?: { at?: string; cron?: string; timeZone: string };
  desk?: string;
}

export const handOver = (task: Pick<BoardTask, 'id' | 'spaceId'>, input: HandOverInput, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/hand-over`, { opId, spaceId: task.spaceId, ...input });
export const reviewDone = (task: Pick<BoardTask, 'id' | 'spaceId'>, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/review`, { opId, spaceId: task.spaceId });
export const snooze = (item: InboxItem, until: string, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(item.taskId ?? '')}/snooze`, { opId, spaceId: item.space, key: item.key, until });
/** Drops a task that is not needed (invalidated), after the undo window. */
export const closeTask = (task: Pick<BoardTask, 'id' | 'spaceId'>, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/close`, { opId, spaceId: task.spaceId });
export const undo = (opId: string) => post(`/api/v1/commands/${encodeURIComponent(opId)}/undo`, {});

// ---- names and colours ----

export const TURN_ORDER: readonly Turn[] = ['needs_you', 'review', 'agent_working', 'agent_scheduled', 'waiting_on_others', 'done'];

export const TURN_META: Record<Turn, { name: string; rule: string; hue: Hue }> = {
  needs_you: { name: 'Needs you', rule: 'You have the next move: answer an agent, do your own task, or decide what happens.', hue: 'you' },
  review: { name: 'Review', rule: 'An agent finished. Stays until you looked at it.', hue: 'review' },
  agent_working: { name: 'Agent working', rule: 'An agent session works on it right now.', hue: 'agent' },
  agent_scheduled: { name: 'Agent scheduled', rule: 'Delegated. An agent picks it up at a set time, or after the task it waits for.', hue: 'scheduled' },
  waiting_on_others: { name: 'Waiting on others', rule: 'Someone outside has the next move. An agent checks back when a job says so.', hue: 'waiting' },
  done: { name: 'Done · 24 h', rule: 'Reviewed by you, or closed in the last 24 hours.', hue: 'done' },
};

export const GROUP_META: Record<TurnGroup, { name: string; hue: Hue }> = {
  asked: { name: 'Asked you', hue: 'you' },
  own: { name: 'Your own tasks', hue: 'mark' },
  parent: { name: 'Waits for its parent', hue: 'stopped' },
  nobody: { name: 'Nobody on it', hue: 'stopped' },
  at_time: { name: 'At a set time', hue: 'scheduled' },
  runner: { name: 'Next in line for the runner', hue: 'scheduled' },
};

/** The hue of a task: its turn's, except a stopped or stuck one is red. */
export function hueOf(task: Pick<BoardTask, 'turn' | 'group' | 'status'>): Hue {
  if (task.group === 'nobody' || task.group === 'parent') return 'stopped';
  if (task.turn) return TURN_META[task.turn].hue;
  return task.status === 'active' ? 'mark' : 'waiting';
}

/** An agent's handle as a name: atlas → Atlas. */
export const agentName = (handle: string | undefined): string =>
  handle ? handle.charAt(0).toUpperCase() + handle.slice(1) : 'The agent';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A brain anchor as a title a person reads: a kebab anchor becomes words, a session's placeholder
 * task (session-2026-11-18-fa1d29c3) its date and short id; anything else stays as written.
 */
export function readable(title: string): string {
  const placeholder = /^session-(\d{4})-(\d{2})-(\d{2})-([0-9a-f]{8})$/.exec(title);
  if (placeholder) return `Session ${Number(placeholder[3])} ${MONTHS[Number(placeholder[2]) - 1] ?? placeholder[2]} · ${placeholder[4]}`;
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(title)) return title;
  const words = title.split(/[-_]/).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---- times ----

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const hhmm = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** A moment as a person says it: "10:27" today, "yesterday 22:09" or "tomorrow 09:00", the weekday within a week, else day and month. */
export function when(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days === 0) return hhmm(d);
  if (days === 1) return `tomorrow ${hhmm(d)}`;
  if (days === -1) return `yesterday ${hhmm(d)}`;
  if (Math.abs(days) <= 6) return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hhmm(d)}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hhmm(d)}`;
}

/** A due date: "today", "tomorrow", "in 3 days", "3 days late", or the date. */
export function dueLabel(due: string, now: number): string {
  const days = Math.round((Date.parse(`${due.slice(0, 10)}T00:00:00`) - startOfDay(now)) / DAY_MS);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1 && days <= 6) return `in ${days} days`;
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} late`;
  return new Date(`${due.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ---- what a card says ----

const NOBODY: Record<NobodyReason, string> = {
  stopped: 'Agent stopped without a next step: continue or close.',
  no_checkpoint: 'Delegated without a checkpoint, so nothing will start it.',
  no_runner: 'Delegated, but this space has no runner.',
  no_owner: 'Nobody owns it: claim it or drop it.',
};

/** The line under a card's title: what is going on, in words. */
export function cardLine(task: BoardTask, now: number): string {
  const agent = agentName(task.delegate);
  if (task.pending?.kind === 'hand_over') return `Handed to ${agent}. You can undo this for a few seconds.`;
  if (task.pending?.kind === 'review') return 'Closing as reviewed. You can undo this for a few seconds.';
  if (task.turn === 'agent_working') return `${agent} is working on it.`;
  if (task.turn === 'review') return task.waitingOn?.why?.replace(/^Review:\s*/, '') || 'The result is ready for your review.';
  if (task.reason) return NOBODY[task.reason];
  if (task.group === 'asked') return task.waitingOn?.why || `${agent} asked you something.`;
  if (task.group === 'parent') return 'Starts when its parent task is active.';
  if (task.turn === 'waiting_on_others') {
    const who = task.waitingOn?.who ?? task.owner ?? 'someone';
    return task.nextRunAt ? `Waiting on ${who}; ${agent} checks back ${when(task.nextRunAt, now)}.` : `Waiting on ${who}.`;
  }
  if (task.group === 'at_time') return `${agent} starts ${when(task.nextRunAt, now)}.`;
  if (task.group === 'runner') return `${agent} is next in line for the runner.`;
  if (task.turn === 'done') return 'Closed.';
  return task.status === 'active' ? 'Your task, in progress.' : 'Your task.';
}

/** The time on a card is the event that put it in its column, named; scheduled work shows its next run. */
export function cardTime(task: BoardTask, now: number): { label: string; future: boolean } | null {
  const named = (word: string, iso: string | null | undefined, future = false) => (iso ? { label: `${word} ${when(iso, now)}`, future } : null);
  if (task.group === 'asked') return named('asked', task.waitingOn?.since);
  if (task.reason === 'stopped') return named('stopped', task.waitingOn?.since);
  if (task.turn === 'review') return named('finished', task.waitingOn?.since ?? task.updatedAt);
  if (task.turn === 'done') return named('closed', task.updatedAt);
  if (task.nextRunAt && (task.turn === 'agent_scheduled' || task.turn === 'waiting_on_others')) return named('next', task.nextRunAt, true);
  if (task.turn === 'waiting_on_others') return named('waiting since', task.waitingOn?.since ?? task.updatedAt);
  return named('updated', task.updatedAt);
}

// ---- Now: the columns ----

export interface Column {
  turn: Turn;
  tasks: BoardTask[];
  groups: Array<{ group: TurnGroup; tasks: BoardTask[] }>;
}

const NEEDS_YOU_GROUPS: readonly TurnGroup[] = ['asked', 'own', 'parent', 'nobody'];
const SCHEDULED_GROUPS: readonly TurnGroup[] = ['at_time', 'runner'];
const latest = (t: BoardTask) => t.waitingOn?.since ?? t.updatedAt ?? '';

/** The board's tasks by whose turn it is, newest first, with the groups inside Needs you and Agent scheduled. */
export function columns(tasks: BoardTask[]): Column[] {
  const onBoard = tasks.filter((t) => t.onBoard && t.turn);
  return TURN_ORDER.map((turn) => {
    const list = onBoard.filter((t) => t.turn === turn).sort((a, b) => latest(b).localeCompare(latest(a)));
    const order = turn === 'needs_you' ? NEEDS_YOU_GROUPS : turn === 'agent_scheduled' ? SCHEDULED_GROUPS : [];
    const groups = order.map((group) => ({ group, tasks: list.filter((t) => t.group === group) })).filter((g) => g.tasks.length > 0);
    return { turn, tasks: list, groups };
  });
}

// ---- Plan ----

export const COVERAGE_META: Record<CoverageGroup, { name: string; hue: Hue }> = {
  ask: { name: 'Answer an agent', hue: 'you' },
  review: { name: 'Look at a result', hue: 'review' },
  due: { name: 'Due soon, nobody on it', hue: 'mark' },
  high: { name: 'High priority, nobody on it', hue: 'stopped' },
  blocked: { name: 'Blocked until you start it', hue: 'stopped' },
  idle: { name: 'Delegated, but nothing will start it', hue: 'stopped' },
  nofollow: { name: 'Waiting, nobody checks back', hue: 'waiting' },
  stopped: { name: 'Agent stopped or never started', hue: 'stopped' },
  owner: { name: 'No owner: claim it or drop it', hue: 'stopped' },
  mine: { name: 'Your tasks', hue: 'mark' },
};
const COVERAGE_ORDER = Object.keys(COVERAGE_META) as CoverageGroup[];

/** In words: who takes care of a task, or what has to happen. */
export function coverageText(task: BoardTask, now: number): string {
  const c = task.coverage;
  const agent = agentName(task.delegate);
  if (c.ok) {
    if (c.how === 'working') return `${agent} working now`;
    if (c.how === 'checks_back') return `waiting on ${task.waitingOn?.who ?? 'someone'} · ${agent} checks ${when(c.at, now)}`;
    if (c.how === 'at_time') return `${agent} · ${when(c.at, now)}`;
    return `${agent} · next in line for the runner`;
  }
  if (c.group === 'ask') return 'answer the agent';
  if (c.group === 'review') return 'review the result';
  if (c.group === 'stopped') return 'agent stopped: continue or close';
  if (c.group === 'blocked') return c.reason === 'steps_wait' ? `start it: ${c.steps} steps wait for it` : 'waits for its parent: start the parent';
  if (c.group === 'idle') return c.reason === 'no_runner' ? 'delegated, but this space has no runner' : 'delegated without a checkpoint: set one';
  if (c.group === 'nofollow') return `waiting on ${task.waitingOn?.who ?? 'someone'} · nobody checks back`;
  if (c.group === 'owner') return 'no owner: claim it or drop it';
  if (c.group === 'due') return `due ${task.due ? dueLabel(task.due, now) : ''}`.trim();
  if (c.group === 'high') return 'high · nobody on it';
  return 'your task';
}

export interface PlanFilter { everyone: boolean; spaceId: string | null }

/** Open tasks in Plan: the viewer's and those nobody owns (Everyone: all), in one space or all. */
export const visibleInPlan = (task: BoardTask, viewer: string, f: PlanFilter) =>
  task.status !== 'resolved' && (f.everyone || !task.owner || task.owner === viewer) && (!f.spaceId || task.spaceId === f.spaceId);

/** Plan's two boxes: important top-level tasks nothing moves without the viewer (by reason), and those an agent covers. */
export function focus(tasks: BoardTask[]) {
  const important = tasks.filter((t) => t.important && !t.parentId).sort((a, b) => b.urgency - a.urgency);
  const act = COVERAGE_ORDER
    .map((group) => ({ group, tasks: important.filter((t) => !t.coverage.ok && t.coverage.group === group) }))
    .filter((g) => g.tasks.length > 0);
  const covered = important.filter((t) => t.coverage.ok).sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9'));
  return { act, actCount: act.reduce((n, g) => n + g.tasks.length, 0), covered };
}

export interface ProjectRow {
  key: string;
  spaceId: string;
  spaceName: string;
  id: string | null;
  name: string;
  goal: string | null;
  open: number;
  needsYou: number;
  delegated: number;
  waiting: number;
  high: number;
  due: string | null;
  urgency: number;
  /** Parents by urgency, each followed by its own steps. */
  tasks: Array<{ task: BoardTask; step: boolean }>;
}

/** One row per project with open tasks, the most urgent first. */
export function projectRows(tasks: BoardTask[], projects: Board['projects']): ProjectRow[] {
  const groups = new Map<string, BoardTask[]>();
  for (const t of tasks) {
    const key = `${t.spaceId}/${t.project ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const first = list[0];
    const p = projects.find((x) => x.spaceId === first.spaceId && x.id === first.project);
    const ids = new Set(list.map((t) => t.id));
    const byUrgency = (a: BoardTask, b: BoardTask) => b.urgency - a.urgency;
    const tops = list.filter((t) => !t.parentId || !ids.has(t.parentId)).sort(byUrgency);
    const dues = list.map((t) => t.due).filter((d): d is string => Boolean(d)).sort();
    return {
      key, spaceId: first.spaceId, spaceName: first.spaceName, id: first.project,
      name: p?.name ?? (first.project ? readable(first.project) : 'No project'), goal: p?.goal ?? null,
      open: list.length,
      needsYou: list.filter((t) => t.turn === 'needs_you').length,
      delegated: list.filter((t) => t.delegate).length,
      waiting: list.filter((t) => t.turn === 'waiting_on_others').length,
      high: list.filter((t) => t.priority === 'high').length,
      due: dues[0] ?? null,
      urgency: Math.max(...list.map((t) => t.urgency)),
      tasks: tops.flatMap((parent) => [{ task: parent, step: false }, ...list.filter((c) => c.parentId === parent.id).sort(byUrgency).map((task) => ({ task, step: true }))]),
    };
  }).sort((a, b) => b.urgency - a.urgency || b.open - a.open);
}

/**
 * The projects Plan's table leaves out: those without an open task the filter shows (none at all,
 * or only someone else's), in the chosen space, by name. The global scope is not a project.
 */
export function quietProjects(rows: ProjectRow[], projects: Board['projects'], f: PlanFilter): Board['projects'] {
  const shown = new Set(rows.map((r) => r.key));
  return projects
    .filter((p) => p.id !== 'global' && (!f.spaceId || p.spaceId === f.spaceId) && !shown.has(`${p.spaceId}/${p.id}`))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Results that needed nobody: done in the last day, delegated with checkpoint none. */
export const fyi = (tasks: BoardTask[]) => tasks.filter((t) => t.turn === 'done' && t.delegate && t.checkpoint === 'none');

/** Snooze times the Inbox offers: tomorrow 09:00 and next Monday 09:00, local time. */
export function snoozeTimes(now: number): { tomorrow: string; monday: string } {
  const at9 = (days: number) => { const d = new Date(startOfDay(now) + days * DAY_MS); d.setHours(9, 0, 0, 0); return d.toISOString(); };
  const weekday = new Date(now).getDay();
  return { tomorrow: at9(1), monday: at9(((8 - weekday) % 7) || 7) };
}

/** The statuses of a task that is still open. */
export const OPEN_STATUSES: ReadonlySet<string> = new Set(['planned', 'active']);

/**
 * Start a session of the user's own on a task (POST /api/v1/tasks/<id>/start): the host binds the task and
 * queues the session; this page claims it and opens the pane (in chat when that is the user's view).
 * Only an older host without the route answers no_route, and only then may the caller start the task in a
 * terminal pane instead. A refusal starts nothing; unknown (no answer, a server error, an unreadable answer) means
 * the host may have started the session, so the caller must not start another one.
 */
export type StartOutcome = { kind: 'started'; sessionId: string | null } | { kind: 'refused'; message: string } | { kind: 'no_route' } | { kind: 'unknown' };
export async function startTaskSession(task: { id: string; spaceId: string }, opts: { projectId?: string; prompt?: string; title?: string; deskId?: string } = {}): Promise<StartOutcome> {
  try {
    const res = await fetch(`/api/v1/tasks/${encodeURIComponent(task.id)}/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spaceId: task.spaceId, ...opts }),
    });
    const body = await res.json().catch(() => null) as { sessionId?: string; error?: { code?: string; message?: string } } | null;
    if (res.ok) return { kind: 'started', sessionId: body?.sessionId ?? null };
    if ((res.status === 404 || res.status === 405) && !body?.error?.code) return { kind: 'no_route' };
    if (res.status < 500 && body?.error?.code) return { kind: 'refused', message: body.error.message ?? 'The cockpit host refused to start it.' };
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}
