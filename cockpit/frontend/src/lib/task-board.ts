// The task board (Inbox · Now · Plan): the host's read model (cockpit/host/src/application/task-board.ts),
// the commands it takes, and the pure helpers the views share. Whose turn a task is comes from the
// host; the page never works it out again, so every count agrees.
import { useEffect } from 'react';
import { keepPreviousData, type QueryClient, type QueryKey, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { runLabel, type RunOutcome, type RunTone } from '@/lib/job-run-label';
import { DAY_MS } from '@/lib/time';
import { clock, dayNumber, formatInZone, userTimeZone, wallClock, zonedTime } from '@/lib/time-zone';
import type { Hue } from '@/shared/view/ui/hue';
import type { RunningCommand } from '@/stores/useTurnStateStore';

export type Turn = 'needs_you' | 'review' | 'agent_working' | 'agent_scheduled' | 'waiting_on_others' | 'parked' | 'done';
export type TurnGroup = 'asked' | 'failed' | 'own' | 'parent' | 'nobody' | 'steps' | 'mission' | 'routine' | 'at_time' | 'runner' | 'blocked' | 'stale';
export type NobodyReason = 'stopped' | 'idle' | 'no_checkpoint' | 'not_handed_over' | 'no_owner' | 'no_project' | 'step_dropped';
export type CoverageGroup = 'ask' | 'review' | 'due' | 'high' | 'blocked' | 'idle' | 'nofollow' | 'stopped' | 'owner' | 'mine';
export type Coverage =
  | { ok: true; how: 'working' | 'at_time' | 'checks_back' | 'runner' | 'parked' | 'steps'; at?: string }
  | { ok: false; group: CoverageGroup; reason?: NobodyReason | 'parent' | 'steps_wait'; steps?: number };

/**
 * Whose move a task waits on (host domain/task-turn.ts WaitingOn). Kinds: question, go, review, stopped, do (a step the
 * person takes themselves, "Your move") and outside. `due`: when the step is due, a date (YYYY-MM-DD) or an instant.
 */
export interface WaitingOn { who: string; kind?: string; why?: string; since?: string; session_id?: string; due?: string }

/**
 * Someone else has the next move (kind outside), but the wait names the person keeping an eye on it: the owner (the
 * task-state migration's blockers) or the viewer. Then the texts say its why, which names the outsider, instead of who.
 *
 * The who of an outside wait has two meanings (host domain/task-turn.ts isViewersMove): that keeper, on older waits,
 * or the name or handle of the one being waited on, on waits an end_turn call wrote (someone outside the space,
 * another member or agent). Those are not kept: the texts name their who, "waiting on <who>".
 */
const keptOutside = (w: WaitingOn | undefined, keeper: Array<string | undefined>): boolean => w?.kind === 'outside' && keeper.includes(w.who);

/** A text as the start of a sentence: its first letter capital, no full stop at the end. */
const sentence = (text: string) => (text.charAt(0).toUpperCase() + text.slice(1)).replace(/\.$/, '');

/** What a task waits on, in words: an outside wait its owner keeps an eye on says its why, else "waiting on <who>". */
function waitText(task: Pick<BoardTask, 'waitingOn' | 'owner'>, fallback = 'someone'): string {
  const w = task.waitingOn;
  if (keptOutside(w, [task.owner])) return w?.why?.replace(/\.$/, '') || 'waiting on someone outside';
  return `waiting on ${w?.who ?? fallback}`;
}

/**
 * One open step of a main task and what covers it (host domain/step-cover.ts StepCover): an agent works on it, it
 * checks back at a time, the runner starts it, it waits on someone, its wait is parked, the owner has a row on it, or
 * it waits on steps of its own. `how` null: nothing covers it, or it stalled.
 */
export interface StepCover {
  id: string;
  name: string;
  how: 'working' | 'checks_back' | 'runner' | 'waits' | 'parked' | 'asked' | 'steps' | null;
  at?: string;
  who?: string;
}

/** Where a step another task waits for stands (host StepState). */
export interface StepState { turn: Turn | null; group?: TurnGroup; reason?: NobodyReason; owner?: string; delegate?: string; waitingOn?: WaitingOn }

/** Why the runner does not start a planned delegated task: the runner's own check (host domain/runner-gate.ts). */
export type RunnerBlock =
  | { kind: 'waiting'; who: string }
  | { kind: 'scheduled' }
  | { kind: 'held' }
  | { kind: 'busy' }
  | { kind: 'parent'; parentId: string; status: string | null }
  | { kind: 'depends'; stepId: string; title: string | null; status: string | null; more: number; step?: StepState }
  | { kind: 'cap'; running: number; max: number; standalone: boolean }
  | { kind: 'no_project'; scope: string }
  | { kind: 'other_member'; owner: string | null };

export interface BoardTask {
  id: string;
  spaceId: string;
  spaceName: string;
  project: string | null;
  title: string;
  /** The name a person reads (display_title); missing until the agent gave one, or from an older host. */
  displayTitle?: string;
  /** Where it stands: the first sentence of its newest handoff's Result (with its Next), else of its newest note. */
  statusLine?: StatusLine;
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
  /** A planned delegated task the runner does not start: why. Missing when it is next in line, or from an older host. */
  runner?: RunnerBlock;
  coverage: Coverage;
  urgency: number;
  important: boolean;
  sessionIds: string[];
  working: boolean;
  /** Its next run, worked out by the host. A time in the past is a run that is due and has not started yet (isDue). */
  nextRunAt: string | null;
  /**
   * It has a schedule (the host decides: the task holds one, also a paused one, or one another member's cockpit
   * fires). Not the same as a next run: a paused schedule has none.
   */
  hasSchedule: boolean;
  /** New channel addresses of the task wait for the user's OK on this cockpit; given in the panel's Schedule section. */
  needsOk?: boolean;
  /** Work on it now ended and released this agent: offer "Hand to <agent>". */
  handTo?: string;
  /**
   * The task's own open session (host domain/own-session.ts): Take over opens it, and Delegate continues it when
   * `continues` (else, or with Start fresh, a new session starts). Missing when it has none, or from an older host.
   */
  ownSession?: { sessionId: string; continues: boolean; why?: 'terminal' | 'long_context' };
  /** What has to be true for it to be done; missing when it has none. */
  goal?: string;
  /** Its schedule (repeating times, a wake-up, paused or not); only on an open task that has one. */
  schedule?: TaskSchedule;
  /** Its open runs, on this cockpit and the other members'; missing when none, or from an older host. */
  runs?: BoardRun[];
  /** Its ended sessions, newest first (at most ten), on every member's cockpit; missing when none. */
  earlierRuns?: EarlierRun[];
  pending?: { opId: string; kind: string; undoUntil: string };
  /** Reopened on the board: decisions and notes that closed with it and come back only through the chat. */
  reopenedWith?: ReopenItem[];
  /** Background commands its sessions here still run, oldest first; missing when none, or from an older host. */
  commands?: RunningCommand[];
  /** Only on a closed task (from Board.closed): when it closed, how it ended, and why Reopen would be refused. */
  closedAt?: string | null;
  outcome?: string;
  stage?: string;
  blocked?: 'superseded' | 'parent_closed';
  /** A replaced task: the task that replaced it, where its work and its sessions go on. */
  replacedBy?: string;
  /**
   * Its open steps, covered first, and whether every one is covered: then it waits on them (group steps). While any is
   * open, Looks good is not offered. Missing when it has none, or from an older host.
   */
  steps?: { open: StepCover[]; covered: boolean };
}

/** A decision or note that closed with a task (host task-commands ReopenItem). */
export interface ReopenItem { id: string; type: string; title: string | null }

/** A closed task (resolved, dropped or replaced) the panel can reopen and ⌘K finds (host Board.closed). */
export interface ClosedTask {
  id: string;
  spaceId: string;
  spaceName: string;
  project: string | null;
  title: string;
  displayTitle?: string;
  status: string;
  closedAt: string | null;
  outcome?: string;
  owner?: string;
  delegate?: string;
  checkpoint?: string;
  stage?: string;
  parentId: string | null;
  originId: string | null;
  sessionIds: string[];
  blocked?: 'superseded' | 'parent_closed';
  /** A replaced task: the task that replaced it, where its work and its sessions go on. */
  replacedBy?: string;
  pending?: { opId: string; kind: string; undoUntil: string };
}

export const CLOSED_STATUSES: ReadonlySet<string> = new Set(['resolved', 'invalidated', 'superseded']);

/**
 * An open task that has a schedule (repeating times, a wake-up that has not fired, also a paused one): it is not
 * closed by approving one run or by Close, only by ending its schedule. The host decides it (hasSchedule); a closed
 * task has none.
 */
export const isScheduled = (task: Pick<BoardTask, 'status' | 'hasSchedule'>): boolean =>
  task.hasSchedule && !CLOSED_STATUSES.has(task.status);

/**
 * An open task with repeating times (a routine): Looks good approves one run and it closes only by ending its
 * schedule. A wake-up alone does not hold a task open: Looks good and Close end it with the task. A schedule the board does not spell out (another member's cockpit fires it)
 * counts as repeating, the careful reading.
 */
export const repeats = (task: Pick<BoardTask, 'status' | 'hasSchedule' | 'schedule'>): boolean =>
  isScheduled(task) && (!task.schedule || (task.schedule.crons?.length ?? 0) > 0);

/** A closed task in the shape the panel takes: no turn, nothing covering it. */
export function closedAsTask(c: ClosedTask): BoardTask {
  return {
    ...c,
    rel: c.parentId ? 'sub' : c.originId ? 'spun' : null,
    updatedAt: c.closedAt,
    turn: null,
    coverage: { ok: false, group: 'idle' },
    urgency: 0,
    important: false,
    working: false,
    nextRunAt: null,
    hasSchedule: false,
  };
}

/** A task's wake-up as an Inbox item carries it: when, and who it is for (an agent checks back; the viewer: a reminder). */
export interface CheckBack { at: string; by: string | null }

export interface InboxItem {
  key: string;
  /**
   * `stopped`: an agent failed or went silent, and only the viewer can get it going again. `do`: a step the viewer
   * takes themselves ("Your move"): an agent asked for it, or a reminder they set fired. `stalled`: a step of one of
   * the viewer's main tasks that nothing moves (taskId is the step, parentId its main task); it clears when it moves.
   */
  kind: 'question' | 'review' | 'stopped' | 'do' | 'stalled';
  space: string;
  title: string;
  text: string;
  since: string;
  taskId?: string;
  sessionId?: string;
  /** The wait's id: what Done names. Missing from an older host. */
  waitId?: string;
  until?: string;
  /** When the step is due: a date (YYYY-MM-DD) or an instant. */
  due?: string;
  /** The task's wake-up: who checks back, and when. The owner's move and the agent's check-back stand side by side. */
  checkBack?: CheckBack;
  /** The task has repeating times: Looks good approves one run instead of closing the task. */
  repeating?: true;
  /** A stalled step: its main task. */
  parentId?: string;
}

/** A closed ancestor of a task with a session, which the board's lists leave out (host Board.lineage). */
export interface LineageTask {
  id: string;
  spaceId: string;
  project: string | null;
  title: string;
  displayTitle?: string;
  status: string;
  parentId: string | null;
  originId: string | null;
}

/** A task's status line (host domain/status-line.ts). */
export interface StatusLine { now: string; next: string | null; at: string }

export interface BoardEvent { at: string; taskId: string; spaceId: string; from: Turn | null; to: Turn | null }

export interface Board {
  at: string;
  viewer: string;
  spaces: Array<{ id: string; name: string; agents: string[] }>;
  projects: Array<{ spaceId: string; id: string; name: string; goal: string | null }>;
  tasks: BoardTask[];
  /** Closed tasks for Reopen and ⌘K; missing from an older host. */
  closed?: ClosedTask[];
  /** Missing from an older host. */
  lineage?: LineageTask[];
  inbox: InboxItem[];
  snoozed: InboxItem[];
  events: BoardEvent[];
  counts: { needsYou: number; inbox: number };
}

// ---- data ----

export const BOARD_KEY = ['task-board'] as const;
/**
 * How often the page asks again when no change arrived over the event stream: only a safety net, since the host
 * sends the `tasks` event within about a second of any change (it watches the brains' log heads).
 */
const BOARD_POLL_MS = 60_000;

/** `signal`: React Query's, so a fetch it gives up on stops downloading instead of competing with the next one. */
export async function fetchBoard(signal?: AbortSignal): Promise<Board> {
  const res = await fetch('/api/v1/tasks/board', { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`The task board did not load (HTTP ${res.status}).`);
  return res.json() as Promise<Board>;
}

/**
 * Load a query again after a change, without throwing away a load already under way. That load may have read the
 * host before the change, so exactly one more runs when it ends, however many changes came meanwhile. A change never
 * cancels a load under way: while sessions work, changes come faster than a slow link loads the board.
 *
 * `inFlight`: per query, whether one more load is owed; shared by every change of one query client.
 */
function refreshAfterChange(client: QueryClient, queryKey: QueryKey, inFlight: Map<string, boolean>): void {
  const id = JSON.stringify(queryKey);
  if (inFlight.has(id)) { inFlight.set(id, true); return; }
  inFlight.set(id, client.isFetching({ queryKey }) > 0);
  void client.invalidateQueries({ queryKey }, { cancelRefetch: false }).finally(() => {
    const again = inFlight.get(id);
    inFlight.delete(id);
    if (again) refreshAfterChange(client, queryKey, inFlight);
  });
}

/** Per query client: how many hooks want the change events, and how to stop listening. */
const changeWatches = new WeakMap<QueryClient, { users: number; stop: () => void }>();

/**
 * One `cockpit:tasks` listener per query client, however many components read the board, so one change starts one
 * load.
 */
function watchTaskChanges(client: QueryClient): () => void {
  let watch = changeWatches.get(client);
  if (!watch) {
    const inFlight = new Map<string, boolean>();
    const changed = () => {
      refreshAfterChange(client, BOARD_KEY, inFlight);
      refreshAfterChange(client, CLOSED_KEY, inFlight);
    };
    window.addEventListener('cockpit:tasks', changed);
    watch = { users: 0, stop: () => window.removeEventListener('cockpit:tasks', changed) };
    changeWatches.set(client, watch);
  }
  const current = watch;
  current.users += 1;
  return () => {
    current.users -= 1;
    if (current.users === 0) { current.stop(); changeWatches.delete(client); }
  };
}

/** The board, refreshed when the host reports a change (the `tasks` event), on reconnect, and every 60 s. */
export function useTaskBoard() {
  const client = useQueryClient();
  useEffect(() => watchTaskChanges(client), [client]);
  return useQuery({ queryKey: BOARD_KEY, queryFn: ({ signal }) => fetchBoard(signal), refetchInterval: BOARD_POLL_MS });
}

/**
 * What the session list takes from the board, as one string: every task's name, status and the session its most urgent
 * wait came from. A session with a task is called by its task (the host's session summary), and whether it waits for
 * you follows its task (host domain/session-attention.ts attentionShown): when this changes, AppContent reloads the list.
 */
export function taskSessionsKey(board: Pick<Board, 'tasks' | 'closed' | 'lineage'>): string {
  const waitOf = (t: object) => ('waitingOn' in t ? (t as Pick<BoardTask, 'waitingOn'>).waitingOn?.session_id ?? '' : '')
  return [...board.tasks, ...(board.closed ?? []), ...(board.lineage ?? [])]
    .map((t) => `${t.id}\u0000${t.displayTitle ?? t.title}\u0000${t.status}\u0000${waitOf(t)}`).sort().join('\u0001');
}

/** A project's newest closed tasks (host GET /api/v1/tasks/closed), done, dropped and replaced; `more` when older ones are left. */
export interface ClosedPage {
  tasks: ClosedTask[];
  more: boolean;
}

export const CLOSED_KEY = ['closed-tasks'] as const;

export async function fetchClosedTasks(spaceId: string, project: string, limit: number, signal?: AbortSignal): Promise<ClosedPage> {
  const query = new URLSearchParams({ spaceId, project, limit: String(limit) });
  const res = await fetch(`/api/v1/tasks/closed?${query}`, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`The closed tasks did not load (HTTP ${res.status}).`);
  return res.json() as Promise<ClosedPage>;
}

/** The closed tasks of each project, up to its limit, while `enabled`; asked again when the board moves. */
export function useClosedTasks(projects: Array<{ spaceId: string; project: string; limit: number }>, enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => (enabled ? watchTaskChanges(client) : undefined), [client, enabled]);
  return useQueries({
    queries: projects.map((p) => ({
      queryKey: [...CLOSED_KEY, p.spaceId, p.project, p.limit] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchClosedTasks(p.spaceId, p.project, p.limit, signal),
      enabled,
      // A bigger page keeps the smaller one on screen while it loads.
      placeholderData: keepPreviousData,
    })),
  });
}

export type CommandAnswer =
  /** sessionId: the task's own session a Take over opens. */
  | { ok: true; opId: string; state: string; undoUntil: string; carriedQuestion?: string; brief?: string; sessionId?: string }
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
/**
 * A task's schedule (the host's task schedule field): repeating times (crons, read in time_zone) and at
 * most one wake-up (at) with its reason (why) and the session that set it (by_session). paused holds for the whole
 * schedule; ends_at ends the repeating times only, a wake-up still fires at its time. The next run is worked out by the host (BoardTask.nextRunAt), never stored. A repeating time
 * starts a new session; a wake-up continues the session that set it.
 */
export interface TaskSchedule {
  crons?: string[];
  at?: string;
  why?: string;
  /** Who the wake-up is for: an agent's handle (it checks back), or the user's own (a reminder). */
  by?: string;
  by_session?: string;
  time_zone?: string;
  paused?: boolean;
  ends_at?: string;
}

/** A session working on a task, as its member's cockpit wrote it (host BoardRun). */
export interface BoardRun {
  id: string;
  member: string;
  agent: string | null;
  state: 'running' | 'idle' | 'stale';
  lastActivityAt: string | null;
  /** This cockpit's own session: it can be opened here. */
  here: boolean;
}

/** An ended session on a task (host EarlierRun): this cockpit's can be reopened, another member's is shown only. */
export interface EarlierRun {
  id: string;
  member: string;
  agent: string | null;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  result: string | null;
  here: boolean;
}

/** How a session ended, in words. */
const ENDED_HOW: Record<string, string> = { finished: 'finished', put_away: 'put away', failed: 'failed', crashed: 'stopped with the cockpit' };

/** An earlier session in one line: agent · when · how it ended · its result line. */
export function earlierRunLine(run: EarlierRun, now: number): string {
  return [agentName(run.agent ?? undefined), when(run.startedAt, now), ENDED_HOW[run.endReason ?? ''] ?? 'ended', run.result].filter(Boolean).join(' · ');
}

export interface HandOverInput {
  mode: HandOverMode;
  delegate: string;
  checkpoint: 'before' | 'after' | 'none';
  /** at: the task's wake-up (it replaces the one it has); cron: one more repeating time. */
  schedule?: { at?: string; cron?: string; timeZone: string };
  desk?: string;
  /** Delegate now: start a new session even when the task has its own session to continue (Start fresh). */
  fresh?: boolean;
}

export const handOver = (task: Pick<BoardTask, 'id' | 'spaceId'>, input: HandOverInput, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/hand-over`, { opId, spaceId: task.spaceId, ...input });
/**
 * Take over a task the agent works on alone: its delegation goes and its own session is the owner's from the end of
 * the turn it is in. It opens where it is shown (the panel's chat, its pane), so no desk is named.
 */
/** What the page says once a Take over went through. */
export const takeOverDone = (agent: string | undefined): string => `Taken over: ${agentName(agent)} finishes the turn it is in, then the session is yours.`;
export const takeOver = (task: Pick<BoardTask, 'id' | 'spaceId' | 'delegate' | 'checkpoint'>, opId = newOpId()) =>
  handOver(task, { mode: 'together', delegate: task.delegate ?? '', checkpoint: (task.checkpoint as HandOverInput['checkpoint'] | undefined) ?? 'after' }, opId);
/** Looks good: closes the task as done, after the undo window. On a scheduled task it approves that run only and the task stays open. */
export const reviewDone = (task: Pick<BoardTask, 'id' | 'spaceId'>, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/review`, { opId, spaceId: task.spaceId });
export const snooze = (item: InboxItem, until: string, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(item.taskId ?? '')}/snooze`, { opId, spaceId: item.space, key: item.key, until });
/** Drops a task that is not needed (invalidated), after the undo window. The host refuses it on a scheduled task (code scheduled). */
export const closeTask = (task: Pick<BoardTask, 'id' | 'spaceId'>, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/close`, { opId, spaceId: task.spaceId });
/** Ends a task's schedule and closes the task as done, after the undo window. */
export const endSchedule = (task: Pick<BoardTask, 'id' | 'spaceId'>, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/end-schedule`, { opId, spaceId: task.spaceId });
/**
 * The schedule's controls (host application/task-commands.ts). They act at once and cannot be undone: the answer's
 * undoUntil is the moment they were made, so the page offers no Undo. Resume undoes Pause.
 */
export const pauseSchedule = (task: Pick<BoardTask, 'id' | 'spaceId'>, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/pause-schedule`, { opId, spaceId: task.spaceId });
export const resumeSchedule = (task: Pick<BoardTask, 'id' | 'spaceId'>, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/resume-schedule`, { opId, spaceId: task.spaceId });
/** A run now, whatever its times say. Refused while its last run is open, a session of it works, or its channel waits for the user's OK. */
export const runNow = (task: Pick<BoardTask, 'id' | 'spaceId'>, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/run-now`, { opId, spaceId: task.spaceId });
/** Removes one repeating time, named as the schedule lists it. Removing the only time of a task without a wake-up ends its schedule; the task stays open. */
export const removeTime = (task: Pick<BoardTask, 'id' | 'spaceId'>, cron: string, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/remove-time`, { opId, spaceId: task.spaceId, cron });
/**
 * The wake-up's controls and Done on a step that is the owner's to take: they act at once, no undo window.
 * Remove takes the wake-up off the task; Reschedule moves it to `at` (an instant), keeping who it is for and why.
 */
export const removeWake = (task: Pick<BoardTask, 'id' | 'spaceId'>, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/remove-wake`, { opId, spaceId: task.spaceId });
export const rescheduleWake = (task: Pick<BoardTask, 'id' | 'spaceId'>, at: string, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/reschedule-wake`, { opId, spaceId: task.spaceId, at });
/** The owner did the step a do wait asks for: the wait goes and the task's agent is woken; its check-back stays. */
export const markDone = (item: Pick<InboxItem, 'taskId' | 'space' | 'waitId'>, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(item.taskId ?? '')}/done`, { opId, spaceId: item.space, waitId: item.waitId ?? '' });
/** The owner saw a review or a question: the ask goes, the task stays open and nobody is woken. Acts at once. */
export const gotIt = (item: Pick<InboxItem, 'taskId' | 'space' | 'waitId'>, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(item.taskId ?? '')}/got-it`, { opId, spaceId: item.space, waitId: item.waitId ?? '' });
/** Removing this repeating time would end the task's schedule: it is the only one and no wake-up is set. */
export const isLastTime = (schedule: TaskSchedule | undefined, cron: string): boolean =>
  !schedule?.at && (schedule?.crons ?? []).every((c) => c === cron);
/** Reopens a closed task (active, starts nothing), after the undo window; owner only. */
export const reopenTask = (task: Pick<BoardTask, 'id' | 'spaceId'>, reason?: string, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/reopen`, { opId, spaceId: task.spaceId, ...(reason?.trim() ? { reason: reason.trim() } : {}) });
/** Reopens a closed task from its chat: once the undo window is over, its newest session gets the message. */
export const continueTask = (task: Pick<BoardTask, 'id' | 'spaceId'>, message: string, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/reopen`, { opId, spaceId: task.spaceId, message });
/** Starts a follow-up of a task: a new task spun off from it with the message as its brief, after the undo window. */
export const followUpTask = (task: Pick<BoardTask, 'id' | 'spaceId'>, message: string, opId = newOpId()) =>
  post(`/api/v1/tasks/${encodeURIComponent(task.id)}/follow-up`, { opId, spaceId: task.spaceId, message });

/** How writing in a closed task's chat goes on: reopen it, or start a follow-up. */
export type ContinueHow = 'reopen' | 'follow_up';
/** The main way, whether reopening is offered at all, and why not or why the main way is a follow-up. */
export interface ContinueMode { primary: ContinueHow; reopen: boolean; note?: string }

/** A task closed longer ago than this gets a follow-up as the main way: the work it held has moved on. */
export const REOPEN_DAYS = 7;

/**
 * How a closed task's chat goes on (decision task-closing-and-continuation-rules): closed within
 * REOPEN_DAYS and reopenable → Send reopens; older → Start follow-up first; replaced or under a closed
 * parent → follow-up only. Null: not the viewer's task, so neither (both are the owner's).
 */
export function continueMode(task: Pick<BoardTask, 'closedAt' | 'owner'> & { blocked?: 'superseded' | 'parent_closed' }, viewer: string | undefined, now: number): ContinueMode | null {
  if (task.owner && viewer && task.owner !== viewer) return null;
  if (task.blocked === 'superseded') return { primary: 'follow_up', reopen: false, note: 'Another task replaced this one, so it can\'t be reopened: a follow-up starts a new task.' };
  if (task.blocked === 'parent_closed') return { primary: 'follow_up', reopen: false, note: 'Its parent is closed, so it can\'t be reopened here: a follow-up starts a new task.' };
  const closed = task.closedAt ? Date.parse(task.closedAt) : NaN;
  if (Number.isFinite(closed) && now - closed > REOPEN_DAYS * DAY_MS) {
    return { primary: 'follow_up', reopen: true, note: `Closed more than ${REOPEN_DAYS} days ago: a follow-up starts a new task. Reopen & send goes on in this one.` };
  }
  return { primary: 'reopen', reopen: true };
}
export const undo = (opId: string) => post(`/api/v1/commands/${encodeURIComponent(opId)}/undo`, {});

// ---- what this cockpit keeps for a task with a schedule ----

export type ReplyChannel = 'mail' | 'slack' | 'whatsapp';
export const REPLY_CHANNELS: readonly ReplyChannel[] = ['mail', 'slack', 'whatsapp'];
export type GrantTool = 'chrome' | 'SendMessage';
export const GRANT_TOOLS: readonly GrantTool[] = ['chrome', 'SendMessage'];

/**
 * The record this cockpit keeps for one task (host domain/job.ts Job, its id is the task's): what only this machine
 * needs. The schedule itself is the task's (BoardTask.schedule), so pause, the times and the next run are not here.
 */
export interface TaskRecord {
  id: string;
  /** The channels that wake the task besides its schedule. */
  triggers: Array<{ type: ReplyChannel }>;
  /** New channel addresses wait for the user's OK: until then the channel does not wake the task. */
  pendingApproval?: boolean;
  /** Per channel: send freely or draft for review. */
  reply: Partial<Record<ReplyChannel, 'send' | 'draft'>>;
  /** Its sessions get no shell, no messages to other sessions and only the brain's tools, unless a tool is lent. */
  limited?: boolean;
  grants?: Array<{ tool: GrantTool; until: string; reason: string | null }>;
  /** Why the cockpit paused the schedule (failures in a row); the pause itself is the schedule's. */
  pausedReason: string | null;
  runCount?: number;
  lastRunAt?: string | null;
  /** The schedule ends once the record has run this often (counted over the record's life, so with runCount). */
  end?: { afterRuns: number } | null;
}

/** How many runs the schedule still has before it ends by its count; null when it has no such end. */
export function runsLeft(record: TaskRecord | null | undefined): number | null {
  const after = record?.end?.afterRuns;
  return typeof after === 'number' ? Math.max(0, after - (record?.runCount ?? 0)) : null;
}
/** "3 more runs", "1 more run", "no more runs". */
export const runsLeftText = (left: number): string => (left === 0 ? 'no more runs' : `${left} more ${left === 1 ? 'run' : 'runs'}`);

/** A run of the task's schedule (host RunView). number 0: a time that was missed or skipped. */
export interface TaskRun {
  id: string;
  number: number;
  trigger: 'schedule' | 'manual' | ReplyChannel;
  dueAt: string;
  status: 'waiting' | 'starting' | 'started' | 'finished' | 'failed' | 'missed' | 'skipped';
  sessionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: RunOutcome | null;
  note: string | null;
  session: { projectId: string | null; chat: boolean; attention: RunOutcome | null } | null;
}

/** GET /api/v1/tasks/<id>/record: `record` null when this cockpit keeps nothing for the task. Runs newest first. */
export interface TaskRecordView { record: TaskRecord | null; runs: TaskRun[]; held: boolean; running: boolean }

export const RECORD_KEY = ['task-record'] as const;
/** Runs start and end on the host's clock: the panel asks again this often while a task is open in it. */
const RECORD_POLL_MS = 15_000;

export async function fetchTaskRecord(task: Pick<BoardTask, 'id' | 'spaceId'>, signal?: AbortSignal): Promise<TaskRecordView> {
  const res = await fetch(`/api/v1/tasks/${encodeURIComponent(task.id)}/record?${new URLSearchParams({ spaceId: task.spaceId })}`, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`The task's schedule settings did not load (HTTP ${res.status}).`);
  return res.json() as Promise<TaskRecordView>;
}

/** What this cockpit keeps for the task, while `enabled` (an open task shown in the panel). */
export function useTaskRecord(task: Pick<BoardTask, 'id' | 'spaceId'>, enabled: boolean) {
  return useQuery({
    queryKey: [...RECORD_KEY, task.spaceId, task.id] as const,
    queryFn: ({ signal }) => fetchTaskRecord(task, signal),
    enabled,
    refetchInterval: RECORD_POLL_MS,
  });
}

/** A change to the record's settings: done, or why the host refused (no_record: this cockpit keeps none for the task). */
export type RecordAnswer = { ok: true } | { ok: false; code: string; message: string };
export type RecordChange =
  | { kind: 'approve' }
  | { kind: 'reply'; channel: ReplyChannel; mode: 'send' | 'draft' }
  | { kind: 'limited'; limited: boolean }
  | { kind: 'grant'; tool: GrantTool }
  | { kind: 'revoke'; tool: GrantTool };

/** POST /api/v1/tasks/<id>/record/<kind>. They apply at once. */
export async function changeRecord(task: Pick<BoardTask, 'id' | 'spaceId'>, change: RecordChange): Promise<RecordAnswer> {
  const { kind, ...body } = change;
  try {
    const res = await fetch(`/api/v1/tasks/${encodeURIComponent(task.id)}/record/${kind}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spaceId: task.spaceId, ...body }),
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    return { ok: false, code: data.error?.code ?? `http_${res.status}`, message: data.error?.message ?? `The cockpit refused (HTTP ${res.status}).` };
  } catch {
    return { ok: false, code: 'offline', message: 'The cockpit did not answer.' };
  }
}

/** What the panel's schedule section asks for: a control of the schedule, or a change to the record. Each applies at once. */
export type ScheduleAction =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'run_now' }
  | { kind: 'remove_time'; cron: string }
  | { kind: 'remove_wake' }
  | { kind: 'reschedule_wake'; at: string }
  | { kind: 'record'; change: RecordChange };

/** What the page says once a schedule control or a setting of the task's record went through. */
export function scheduleDone(task: Pick<BoardTask, 'schedule'>, action: ScheduleAction): string {
  if (action.kind === 'pause') return 'Schedule paused: nothing runs until you resume it.';
  if (action.kind === 'resume') return 'Schedule resumed.';
  if (action.kind === 'run_now') return 'Run started: how it goes shows under its last runs.';
  if (action.kind === 'remove_time') return isLastTime(task.schedule, action.cron) ? 'Time removed and schedule ended. The task stays open.' : 'Time removed.';
  if (action.kind === 'remove_wake') return 'Wake-up removed.';
  if (action.kind === 'reschedule_wake') return `Wake-up moved to ${when(action.at, Date.now())}.`;
  const c = action.change;
  if (c.kind === 'approve') return 'Approved: its messages wake the task from now.';
  if (c.kind === 'reply') return c.mode === 'send' ? `Its ${c.channel} replies are sent without asking.` : `Its ${c.channel} replies are drafts you approve.`;
  if (c.kind === 'limited') return c.limited ? 'Its sessions are limited.' : 'Its sessions are no longer limited.';
  const tool = c.tool === 'chrome' ? 'Chrome' : 'Messages';
  return c.kind === 'grant' ? `${tool} lent for 1 h.` : `${tool} taken back.`;
}

/** The tools lent to a limited task that are still lent now. */
export const activeGrants = (record: TaskRecord | null | undefined, now: number) =>
  (record?.grants ?? []).filter((g) => Date.parse(g.until) > now);

/**
 * The record has something to show in the panel: a channel that wakes the task, addresses waiting for the user's OK,
 * the Limited switch on, or a tool lent. A record that only counts runs shows nothing.
 */
export const recordShows = (record: TaskRecord | null | undefined, now: number): boolean =>
  Boolean(record && (record.triggers.length > 0 || record.pendingApproval || record.limited || activeGrants(record, now).length > 0));

/** A run in one line: when, how it went (the newest as its session stands now), and why it did not run. */
export function runLine(run: TaskRun, now: number, current = false): { text: string; tone: RunTone } {
  const label = runLabel({ status: run.status, outcome: run.outcome, attention: run.session?.attention ?? null, sessionKnown: Boolean(run.session) }, current);
  const by = run.trigger === 'manual' ? 'run by hand' : run.trigger === 'schedule' ? null : `on ${run.trigger}`;
  return { text: [when(run.startedAt ?? run.finishedAt ?? run.dueAt, now), by, label.text, run.note].filter(Boolean).join(' · '), tone: label.tone };
}

/** What a task whose channel waits for the user's OK says on its card, its Plan row and in its panel. */
export const NEEDS_OK = 'waiting for your OK';

// ---- names and colours ----

export const TURN_ORDER: readonly Turn[] = ['needs_you', 'review', 'agent_working', 'agent_scheduled', 'waiting_on_others', 'parked', 'done'];

export const TURN_META: Record<Turn, { name: string; rule: string; hue: Hue }> = {
  needs_you: { name: 'Needs you', rule: 'You have the next move: answer an agent, do your own task, or decide what happens.', hue: 'you' },
  review: { name: 'Review', rule: 'An agent finished. Stays until you looked at it.', hue: 'review' },
  agent_working: { name: 'Agent working', rule: 'An agent session works on it right now.', hue: 'agent' },
  agent_scheduled: { name: 'Agent scheduled', rule: 'Delegated. An agent picks it up at a set time, when the runner has a free slot, or after the step it waits for.', hue: 'scheduled' },
  waiting_on_others: { name: 'Waiting on others', rule: 'Someone outside has the next move. An agent checks back when the task\'s schedule says so.', hue: 'waiting' },
  parked: { name: 'Parked', rule: 'Its wait is snoozed: it comes back by itself at the date, on every device. Nothing runs meanwhile.', hue: 'waiting' },
  done: { name: 'Done · 24 h', rule: 'Reviewed by you, or closed in the last 24 hours.', hue: 'done' },
};

export const GROUP_META: Record<TurnGroup, { name: string; hue: Hue }> = {
  asked: { name: 'Asked you', hue: 'you' },
  own: { name: 'Your own tasks', hue: 'mark' },
  parent: { name: 'Waits for its parent', hue: 'stopped' },
  nobody: { name: 'Nobody on it', hue: 'stopped' },
  steps: { name: 'Waiting on its steps', hue: 'scheduled' },
  failed: { name: 'Agent stopped', hue: 'stopped' },
  mission: { name: 'Missions: until the goal is reached', hue: 'scheduled' },
  routine: { name: 'Routines', hue: 'scheduled' },
  at_time: { name: 'Starts later', hue: 'scheduled' },
  runner: { name: 'Next in line for the runner', hue: 'scheduled' },
  blocked: { name: 'Waits before it starts', hue: 'waiting' },
  stale: { name: 'Stale: no activity for over an hour', hue: 'stopped' },
};

/** The hue of a task: its turn's, except a stopped or stuck one is red. */
export function hueOf(task: Pick<BoardTask, 'turn' | 'group' | 'status'>): Hue {
  if (task.group === 'nobody' || task.group === 'parent' || task.group === 'stale') return 'stopped';
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
/** The name of a task as people read it: its display title, else its anchor as words. */
export function taskName(task: { title: string; displayTitle?: string }): string {
  return task.displayTitle?.trim() || readable(task.title);
}

/** The name of the task a task was spun off from, when the board knows it (open, or a closed ancestor in lineage). */
export function originName(task: Pick<BoardTask, 'originId' | 'spaceId'>, board: Pick<Board, 'tasks' | 'lineage'>): string | null {
  if (!task.originId) return null;
  const origin = board.tasks.find((t) => t.id === task.originId && t.spaceId === task.spaceId)
    ?? (board.lineage ?? []).find((t) => t.id === task.originId && t.spaceId === task.spaceId);
  return origin ? taskName(origin) : null;
}

export function readable(title: string): string {
  const placeholder = /^session-(\d{4})-(\d{2})-(\d{2})-([0-9a-f]{8})$/.exec(title);
  if (placeholder) return `Session ${Number(placeholder[3])} ${MONTHS[Number(placeholder[2]) - 1] ?? placeholder[2]} · ${placeholder[4]}`;
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(title)) return title;
  const words = title.split(/[-_]/).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---- times ----

/**
 * A moment as a person says it: "10:27" today, "yesterday 22:09" or "tomorrow 09:00", the weekday within a week,
 * else day and month. In the user's time zone (lib/time-zone.ts), whatever zone the browser runs in.
 */
export function when(iso: string | null | undefined, now: number, zone: string = userTimeZone()): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const hhmm = clock(at, zone);
  const days = dayNumber(at, zone) - dayNumber(now, zone);
  if (days === 0) return hhmm;
  if (days === 1) return `tomorrow ${hhmm}`;
  if (days === -1) return `yesterday ${hhmm}`;
  if (Math.abs(days) <= 6) return `${formatInZone(at, { weekday: 'short' }, zone)} ${hhmm}`;
  return `${formatInZone(at, { day: 'numeric', month: 'short' }, zone)} ${hhmm}`;
}

/** A due date (a calendar day, no zone of its own): "today", "tomorrow", "in 3 days", "3 days late", or the date. Today is the user's. */
export function dueLabel(due: string, now: number, zone: string = userTimeZone()): string {
  const date = Date.parse(`${due.slice(0, 10)}T00:00:00Z`);
  const days = Math.round(date / DAY_MS) - dayNumber(now, zone);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1 && days <= 6) return `in ${days} days`;
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} late`;
  return formatInZone(date, { day: 'numeric', month: 'short' }, 'UTC');
}

/**
 * When a step the owner takes is due, for its Inbox item: "due today", "overdue", "due tomorrow", else "due" and the
 * date (a date has no zone of its own; today is the user's). An instant says its time too: "due today 17:00".
 */
export function askDueLabel(due: string, now: number, zone: string = userTimeZone()): { text: string; overdue: boolean } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    const days = Math.round(Date.parse(`${due}T00:00:00Z`) / DAY_MS) - dayNumber(now, zone);
    if (days < 0) return { text: 'overdue', overdue: true };
    if (days === 0) return { text: 'due today', overdue: false };
    if (days === 1) return { text: 'due tomorrow', overdue: false };
    return { text: `due ${formatInZone(Date.parse(`${due}T00:00:00Z`), { day: 'numeric', month: 'short' }, 'UTC')}`, overdue: false };
  }
  const at = Date.parse(due);
  if (!Number.isFinite(at)) return { text: `due ${due}`, overdue: false };
  if (at <= now) return { text: 'overdue', overdue: true };
  const days = dayNumber(at, zone) - dayNumber(now, zone);
  return { text: days === 0 ? `due today ${clock(at, zone)}` : `due ${when(due, now, zone)}`, overdue: false };
}

/**
 * Who a wake-up is for, in words: "Nova checks back", or `own` when it is the viewer's (a reminder: "Reminder", "Reminder
 * for you" in the panel); "Wake-up" when it names nobody. `short`: the agent's name alone, for a chip ("Nova").
 */
export function checkBackWho(by: string | null | undefined, viewer: string | undefined, opts: { own?: string; short?: boolean } = {}): string {
  if (!by) return 'Wake-up';
  if (viewer && by === viewer) return opts.own ?? 'Reminder';
  return opts.short ? agentName(by) : `${agentName(by)} checks back`;
}

/** Who a wake-up is for and when, in words: "Nova checks back tomorrow 09:00", "Reminder 09:00", "Wake-up 09:00". */
export function checkBackText(check: CheckBack, viewer: string | undefined, now: number, own?: string): string {
  return `${checkBackWho(check.by, viewer, own ? { own } : {})} ${when(check.at, now)}`;
}

/**
 * The approve button of a review in the Inbox: on a task without repeating times Looks good closes it, and a
 * wake-up it has ends with it, which the button says. With repeating times it approves one run.
 */
export function looksGoodLabel(item: Pick<InboxItem, 'checkBack' | 'repeating'>, viewer: string | undefined): string {
  const check = item.checkBack;
  if (!check || item.repeating) return 'Looks good';
  const whose = !check.by ? 'the check' : viewer && check.by === viewer ? 'your reminder' : `${agentName(check.by)}'s check`;
  return `Looks good · closes the task, ends ${whose}`;
}

/** A next run whose time has come: the host holds it as due until it starts (a run waiting for room, a time not fired yet). */
export const isDue = (iso: string | null | undefined, now: number): boolean => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) && at <= now;
};

/** A task's next run after a word of its own: "next Mon 09:00", or "due since 10:27" once its time has come. */
export function nextRunText(iso: string | null | undefined, now: number, word = 'next'): string {
  if (!iso) return '';
  return isDue(iso, now) ? `due since ${when(iso, now)}` : `${word} ${when(iso, now)}`;
}

// ---- what a card says ----

const NOBODY: Record<NobodyReason, string> = {
  stopped: 'Agent stopped without a next step: continue or close.',
  idle: 'Its session is open but idle: nothing asked, nothing scheduled. Write to it or close the task.',
  no_checkpoint: 'Delegated without a checkpoint, so nothing will start it.',
  not_handed_over: 'Delegated but not handed over yet, so nothing starts it: hand it over to let the agent start.',
  no_owner: 'Nobody owns it: claim it or drop it.',
  no_project: 'Delegated outside a project, so the runner has nowhere to start it: move it into a project.',
  step_dropped: 'Waits for a step that will never finish: change the plan.',
};

const quoted = (title: string | null) => (title ? `“${readable(title)}”` : 'a step');

/** Where the step a task waits for stands, after "Waits for …". */
function stepLine(block: Extract<RunnerBlock, { kind: 'depends' }>): string {
  const name = quoted(block.title);
  const step = block.step;
  if (block.status === 'invalidated') return `${name}, which was dropped. Remove the dependency or drop this step`;
  if (block.status === 'superseded') return `${name}, which was replaced. Point it at the new step`;
  if (block.status === null) return `a step the brain no longer has. Remove the dependency`;
  if (!step) return `${name} (${block.status})`;
  if (step.turn === 'review') {
    const pr = /\bPR #\d+/.exec(step.waitingOn?.why ?? '')?.[0];
    return `your review of ${pr ?? name}`;
  }
  if (step.group === 'asked') return `your ${step.waitingOn?.kind === 'go' ? 'go' : step.waitingOn?.kind === 'do' ? 'move' : 'answer'} on ${name}`;
  if (step.group === 'own') return `your task ${name}`;
  if (step.group === 'parent') return `${name}, which waits for its parent`;
  if (step.group === 'nobody') return `${name}, which nobody is on`;
  if (step.turn === 'agent_working') return `${name}, which ${agentName(step.delegate)} is working on`;
  if (step.group === 'at_time') return `${name}, which starts at a set time`;
  if (step.group === 'runner') return `${name}, next in line for the runner`;
  if (step.group === 'blocked') return `${name}, which waits itself`;
  if (step.turn === 'waiting_on_others') return `${name}, which waits on ${keptOutside(step.waitingOn, [step.owner]) ? 'someone outside' : step.waitingOn?.who ?? step.owner ?? 'someone'}`;
  return name;
}

/** Why the runner does not start the task, in words; null when nothing holds it. */
export function runnerLine(task: Pick<BoardTask, 'runner' | 'delegate'>): string | null {
  const b = task.runner;
  const agent = agentName(task.delegate);
  if (!b) return null;
  if (b.kind === 'depends') return `Waits for ${stepLine(b)}${b.more > 0 ? ` (and ${b.more} more step${b.more === 1 ? '' : 's'})` : ''}.`;
  if (b.kind === 'cap') return `Waits for a free slot: ${b.running} of ${b.max} ${b.standalone ? 'delegated tasks' : 'steps of its parent'} run.`;
  if (b.kind === 'busy') return 'A session is open on it, so the runner leaves it to that session.';
  if (b.kind === 'held') return `Just handed over, or you work on it with ${agent}: the runner leaves it alone for now.`;
  if (b.kind === 'parent') return b.status === 'active' || b.status === 'planned' ? 'Starts when its parent task is active.' : 'Its parent task is closed, so it will not start.';
  if (b.kind === 'no_project') return NOBODY.no_project;
  if (b.kind === 'other_member') return `${agent} is next in line on ${b.owner ? `${agentName(b.owner)}'s` : 'its owner\'s'} cockpit.`;
  if (b.kind === 'waiting') return `Waiting on ${b.who}.`;
  return null;
}

/** What covers one open step, in words: "Atlas working", "checks back Fri 4 Dec 10:00", "waits on Kim". */
export function stepCoverText(step: StepCover, now: number): string {
  if (step.how === 'working') return `${agentName(step.who)} working`;
  if (step.how === 'checks_back') return step.at ? `${isDue(step.at, now) ? `due since ${when(step.at, now)}` : `checks back ${when(step.at, now)}`}` : 'checks back later';
  if (step.how === 'runner') return `${agentName(step.who)} next in line`;
  if (step.how === 'waits') return `waits on ${step.who?.replace(/^outside:/i, '') ?? 'someone'}`;
  if (step.how === 'parked') return 'parked';
  if (step.how === 'asked') return 'waits for you';
  if (step.how === 'steps') return 'waits on its own steps';
  return 'nobody on it';
}

/** A main task's open steps, in words: "Waiting on step Delete the legacy service · Atlas working (and 1 more)". */
export function stepsLine(task: Pick<BoardTask, 'steps'>, now: number): string {
  const first = task.steps?.open[0];
  if (!first) return 'Waiting on its steps';
  const more = (task.steps?.open.length ?? 1) - 1;
  return `Waiting on step ${first.name} · ${stepCoverText(first, now)}${more > 0 ? ` (and ${more} more)` : ''}`;
}

/** The task has open steps: it cannot be closed, so Looks good is not offered. */
export const hasOpenSteps = (task: Pick<BoardTask, 'steps'> | undefined): boolean => (task?.steps?.open.length ?? 0) > 0;

/** The line under a card's title: what is going on, in words. */
export function cardLine(task: BoardTask, now: number): string {
  const agent = agentName(task.delegate);
  // A run whose time has come is due, not a time in the past the agent "starts" at.
  const runs = (verb: string) => (isDue(task.nextRunAt, now) ? `${agent}'s run is due since ${when(task.nextRunAt, now)}` : `${agent} ${verb} ${when(task.nextRunAt, now)}`);
  if (task.pending?.kind === 'hand_over') return `Handed to ${agent}. You can undo this for a few seconds.`;
  // A review of a task whose schedule is on closes nothing: the host shows the task as still open.
  if (task.pending?.kind === 'review') return `${CLOSED_STATUSES.has(task.status) ? 'Closing as reviewed.' : 'Run approved.'} You can undo this for a few seconds.`;
  if (task.pending?.kind === 'end_schedule') return 'Ending its schedule and closing. You can undo this for a few seconds.';
  if (task.turn === 'agent_working') return workingLine(task, now);
  if (task.turn === 'review') return task.waitingOn?.why?.replace(/^Review:\s*/, '') || 'The result is ready for your review.';
  if (task.reason === 'step_dropped' || task.reason === 'no_project') return runnerLine(task) ?? NOBODY[task.reason];
  if (task.reason) return NOBODY[task.reason];
  if (task.group === 'asked' && task.waitingOn?.kind === 'do') return task.waitingOn.why ? `Your move: ${task.waitingOn.why.replace(/\.$/, '')}.` : 'Your move.';
  if (task.group === 'asked') return task.waitingOn?.why || `${agent} asked you something.`;
  if (task.group === 'parent') return runnerLine(task) ?? 'Starts when its parent task is active.';
  if (task.group === 'blocked') return runnerLine(task) ?? `${agent} waits before it starts.`;
  if (task.group === 'steps') return `${stepsLine(task, now)}.`;
  if (task.turn === 'waiting_on_others') {
    const waits = sentence(waitText(task, task.owner));
    return task.nextRunAt ? `${waits}; ${runs('checks back')}.` : `${waits}.`;
  }
  if (task.turn === 'agent_scheduled' && task.waitingOn?.kind === 'outside') return `${sentence(waitText(task))}; ${runs('checks again')}.`;
  if (task.group === 'mission') return `Until the goal is reached. ${sentence(runs('checks again'))}.`;
  // Past its end (ends_at) the repeating times repeat no more; what is next then is its wake-up.
  if (task.group === 'routine') return `${isDue(task.schedule?.ends_at, now) ? 'Its repeating times have ended' : repeatsText(task.schedule)}. ${sentence(nextRunText(task.nextRunAt, now))}.`;
  if (task.group === 'at_time') return `${sentence(runs('starts'))}.`;
  if (task.group === 'runner') return runnerLine(task) ?? `${agent} is next in line for the runner.`;
  if (task.turn === 'done') return 'Closed.';
  if (task.handTo) return `You worked on it with ${agentName(task.handTo)}. Hand it to ${agentName(task.handTo)} to let it go on alone.`;
  return task.status === 'active' ? 'Your task, in progress.' : 'Your task.';
}

/** Who works on it and where: this cockpit's session, another member's, or one gone silent. */
function workingLine(task: BoardTask, now: number): string {
  const run = task.runs?.find((r) => r.state === 'running') ?? task.runs?.[0];
  const who = agentName(run?.agent ?? task.delegate);
  if (task.group === 'stale' && run) return `${who} has been silent since ${when(run.lastActivityAt, now)}. It may have crashed: open it or run it again.`;
  if (run && !run.here) return `${who} is working on it, on ${agentName(run.member)}'s cockpit.`;
  return `${who} is working on it.`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const two = (n: number) => String(n).padStart(2, '0');
const listed = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

const CRON_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * The values one cron field names (numbers, lists, ranges, steps), sorted; null when it is not such a field.
 * `names`: the field also takes these words for 0, 1, … (the weekday's SUN to SAT), as the host's parser does.
 */
function cronField(field: string, min: number, max: number, names: string[] | null = null): number[] | null {
  const value = (part: string): number => {
    const index = names ? names.indexOf(part.toUpperCase()) : -1;
    return index >= 0 ? index : /^\d+$/.test(part) ? Number(part) : NaN;
  };
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const pieces = part.split('/');
    if (pieces.length > 2) return null;
    const [range, stepText] = pieces;
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : NaN;
    const ends = range.split('-');
    if (ends.length > 2) return null;
    const [from, to] = range === '*' ? [min, max] : ends.length === 2 ? [value(ends[0]), value(ends[1])] : [value(range), stepText === undefined ? value(range) : max];
    if (!(from >= min && to <= max && from <= to && step >= 1)) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * A repeating time in words, as the host says it to a session (host domain/run-text.ts cronInWords): "on weekdays at
 * 08:00", "every day at 18:00 and 22:00", "every Monday and Thursday at 09:30", "on day 1 of every month at 07:00",
 * "every hour at :15". Null for a rule none of these fit: the caller shows the rule itself.
 */
export function cronWords(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, day, month, weekday] = fields;
  const minutes = cronField(minute, 0, 59), hours = cronField(hour, 0, 23), days = cronField(day, 1, 31);
  // Sunday is 0 or 7.
  const weekdays = cronField(weekday, 0, 7, CRON_DAYS)?.map((d) => d % 7);
  if (!minutes || !hours || !days || !weekdays || month !== '*' || minutes.length !== 1) return null;
  const everyHour = hour === '*';
  if (!everyHour && hours.length > 6) return null;
  const at = everyHour ? `every hour at :${two(minutes[0])}` : `at ${listed(hours.map((h) => `${two(h)}:${two(minutes[0])}`))}`;
  let on: string;
  if (day === '*' && weekday === '*') on = everyHour ? '' : 'every day';
  else if (day === '*') {
    const set = [...new Set(weekdays)].sort((a, b) => a - b);
    if (set.length === 7) on = everyHour ? '' : 'every day';
    else if (set.join() === '1,2,3,4,5') on = 'on weekdays';
    else if (set.join() === '0,6') on = 'at the weekend';
    else on = `${everyHour ? 'on' : 'every'} ${listed(set.map((d) => WEEKDAYS[d]))}`;
  } else if (weekday === '*') {
    if (days.length > 4) return null;
    on = `on day ${listed(days.map(String))} of every month`;
  } else return null;
  return everyHour ? [at, on].filter(Boolean).join(' ') : `${on} ${at}`;
}

/** One repeating time as a line of its own: in words, else the rule itself. */
export const timeText = (cron: string): string => { const words = cronWords(cron); return words ? sentence(words) : cron; };

/**
 * The zone a schedule's repeating times are read in, named only when it is not the user's own (Settings): the times
 * are said as the schedule holds them, so in another zone the reader has to know which.
 */
export const scheduleZone = (schedule: TaskSchedule | undefined, zone: string = userTimeZone()): string | null =>
  schedule?.time_zone && schedule.time_zone !== zone ? schedule.time_zone : null;

/** A schedule's repeating times in words, one after the other; a rule the words do not fit shows as itself. */
export function repeatsText(schedule: TaskSchedule | undefined, zone: string = userTimeZone()): string {
  const crons = schedule?.crons ?? [];
  if (crons.length === 0) return 'Repeats';
  const other = scheduleZone(schedule, zone);
  return `Repeats ${crons.map((cron) => cronWords(cron) ?? `(${cron})`).join('; ')}${other ? ` (${other})` : ''}`;
}

/**
 * The line under a task's name on a card: where it stands (its status line), unless something more
 * urgent says why it sits where it is — an undo window, a question to answer, a stop, a wait for its parent.
 */
export function statusOrTurn(task: BoardTask, now: number): string {
  const urgent = task.pending || task.group === 'asked' || task.reason || task.group === 'parent' || task.group === 'blocked' || task.group === 'steps';
  return !urgent && task.statusLine ? task.statusLine.now : cardLine(task, now);
}

/** The time on a card is the event that put it in its column, named; scheduled work shows its next run. */
export function cardTime(task: BoardTask, now: number): { label: string; future: boolean } | null {
  const named = (word: string, iso: string | null | undefined, future = false) => (iso ? { label: `${word} ${when(iso, now)}`, future } : null);
  if (task.group === 'asked') return named('asked', task.waitingOn?.since);
  if (task.reason === 'stopped') return named('stopped', task.waitingOn?.since);
  if (task.reason === 'idle') return named('idle since', task.runs?.[0]?.lastActivityAt ?? task.updatedAt);
  if (task.turn === 'agent_working') return named('last activity', task.runs?.find((r) => r.state === 'running')?.lastActivityAt ?? task.runs?.[0]?.lastActivityAt ?? task.updatedAt);
  if (task.turn === 'review') return named('finished', task.waitingOn?.since ?? task.updatedAt);
  if (task.turn === 'done') return named('closed', task.updatedAt);
  if (task.nextRunAt && (task.turn === 'agent_scheduled' || task.turn === 'waiting_on_others')) return { label: nextRunText(task.nextRunAt, now), future: true };
  if (task.turn === 'waiting_on_others') return named('waiting since', task.waitingOn?.since ?? task.updatedAt);
  return named('updated', task.updatedAt);
}

// ---- Now: the columns ----

export interface Column {
  turn: Turn;
  tasks: BoardTask[];
  groups: Array<{ group: TurnGroup; tasks: BoardTask[] }>;
}

const NEEDS_YOU_GROUPS: readonly TurnGroup[] = ['asked', 'failed', 'own', 'parent', 'nobody'];
const SCHEDULED_GROUPS: readonly TurnGroup[] = ['steps', 'mission', 'routine', 'at_time', 'runner', 'blocked'];
const WORKING_GROUPS: readonly TurnGroup[] = ['stale'];
const latest = (t: BoardTask) => t.waitingOn?.since ?? t.updatedAt ?? '';

/** The board's tasks by whose turn it is, newest first, with the groups inside Needs you and Agent scheduled. */
export function columns(tasks: BoardTask[]): Column[] {
  return TURN_ORDER.map((turn) => {
    const list = tasks.filter((t) => t.turn === turn).sort((a, b) => latest(b).localeCompare(latest(a)));
    const order = turn === 'needs_you' ? NEEDS_YOU_GROUPS : turn === 'agent_scheduled' ? SCHEDULED_GROUPS : turn === 'agent_working' ? WORKING_GROUPS : [];
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
    if (c.how === 'parked') return c.at ? `parked · back ${when(c.at, now)}` : 'parked until you bring it back';
    if (c.how === 'checks_back') return `${waitText(task)} · ${agent} ${isDue(c.at, now) ? `due since ${when(c.at, now)}` : `checks ${when(c.at, now)}`}`;
    if (c.how === 'at_time') return `${agent} · ${isDue(c.at, now) ? `due since ${when(c.at, now)}` : when(c.at, now)}`;
    if (c.how === 'steps') return stepsLine(task, now);
    const b = task.runner;
    if (b?.kind === 'depends') return `${agent} · after ${b.step?.turn === 'review' ? 'your review of ' : ''}${quoted(b.title)}`;
    if (b?.kind === 'cap') return `${agent} · waits for a free slot (${b.running} of ${b.max} run)`;
    if (b?.kind === 'busy') return `${agent} · a session is open on it`;
    if (b?.kind === 'held') return `${agent} · held for now`;
    if (b?.kind === 'other_member') return `${agent} · next in line on ${b.owner ? `${agentName(b.owner)}'s` : 'its owner\'s'} cockpit`;
    return `${agent} · next in line for the runner`;
  }
  if (c.group === 'ask') return 'answer the agent';
  if (c.group === 'review') return 'review the result';
  if (c.group === 'stopped') return 'agent stopped: continue or close';
  if (c.group === 'blocked') return c.reason === 'steps_wait' ? `start it: ${c.steps} steps wait for it` : 'waits for its parent: start the parent';
  if (c.group === 'idle') {
    if (c.reason === 'no_project') return 'delegated outside a project: move it into one';
    if (c.reason === 'step_dropped') return 'waits for a step that will never finish: change the plan';
    return 'delegated without a checkpoint: set one';
  }
  if (c.group === 'nofollow') return `${waitText(task)} · nobody checks back`;
  if (c.group === 'owner') return 'no owner: claim it or drop it';
  if (c.group === 'due') return `due ${task.due ? dueLabel(task.due, now) : ''}`.trim();
  if (c.group === 'high') return 'high · nobody on it';
  return 'your task';
}

/** The Owner and Space picks Now and Plan share. */
export interface TaskFilter { everyone: boolean; spaceId: string | null }

/** The filter as the board can use it: a space the board no longer has falls back to All. */
export const resolveFilter = (f: TaskFilter, spaces: Board['spaces']): TaskFilter =>
  f.spaceId && !spaces.some((s) => s.id === f.spaceId) ? { ...f, spaceId: null } : f;

/** A task the filter keeps: the viewer's and those nobody owns (Everyone: all), in one space or all. */
export const inFilter = (task: BoardTask, viewer: string, f: TaskFilter) =>
  (f.everyone || !task.owner || task.owner === viewer) && (!f.spaceId || task.spaceId === f.spaceId);

/** Open tasks in Plan, as the filter keeps them. */
export const visibleInPlan = (task: BoardTask, viewer: string, f: TaskFilter) =>
  task.status !== 'resolved' && inFilter(task, viewer, f);

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
export function quietProjects(rows: ProjectRow[], projects: Board['projects'], f: TaskFilter): Board['projects'] {
  const shown = new Set(rows.map((r) => r.key));
  return projects
    .filter((p) => p.id !== 'global' && (!f.spaceId || p.spaceId === f.spaceId) && !shown.has(`${p.spaceId}/${p.id}`))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Results that needed nobody: done in the last day, delegated with checkpoint none. */
export const fyi = (tasks: BoardTask[]) => tasks.filter((t) => t.turn === 'done' && t.delegate && t.checkpoint === 'none');

/** Snooze times the Inbox offers: tomorrow 09:00 and next Monday 09:00, in the user's time zone. */
export function snoozeTimes(now: number, zone: string = userTimeZone()): { tomorrow: string; monday: string } {
  const today = wallClock(now, zone);
  const at9 = (days: number) => {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + days));
    const at = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), minute: 0 };
    // 09:00 is never in a daylight-saving gap anywhere; 10:00 covers it all the same.
    return new Date(zonedTime({ ...at, hour: 9 }, zone) ?? zonedTime({ ...at, hour: 10 }, zone) ?? now).toISOString();
  };
  return { tomorrow: at9(1), monday: at9(((8 - today.weekday) % 7) || 7) };
}

/** The statuses of a task that is still open. */
export const OPEN_STATUSES: ReadonlySet<string> = new Set(['planned', 'active']);

/**
 * Start a session of the user's own on a task (POST /api/v1/tasks/<id>/start): the host binds the task and
 * queues the session; this page claims it and opens the pane, in the chat.
 * Only an older host without the route answers no_route, and only then may the caller start the task in a
 * chat pane of its own instead. A refusal starts nothing; unknown (no answer, a server error, an unreadable answer) means
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

// ---- the task panel ----

/** A session's state as its tab names it, most in need of the viewer first (decision task-sessions-listed-by-attention). */
export type SessionState = 'needs input' | 'review' | 'silent' | 'working' | 'idle' | 'done';
export const SESSION_ORDER: Record<SessionState, number> = { 'needs input': 0, review: 1, silent: 2, working: 3, idle: 4, done: 5 };

/** What a session on the task is doing, from the task's wait on it, its run, and whether it is put away. */
export function sessionState(task: BoardTask, sessionId: string, archived: boolean, run: BoardRun | undefined): SessionState {
  if (task.waitingOn?.session_id === sessionId) return task.waitingOn.kind === 'review' ? 'review' : 'needs input';
  if (archived) return 'done';
  if (run?.state === 'stale') return 'silent';
  if (run?.state === 'running') return 'working';
  return 'idle';
}

/** "Waiting on" in one short line: whose move it is, a question count when the agent asked several, and since when. */
export function waitingLine(task: BoardTask, viewer: string): string {
  const w = task.waitingOn;
  if (!w) return '';
  if (keptOutside(w, [viewer, task.owner])) return w.why ? `Outside · ${w.why}` : 'Outside';
  const who = w.who === viewer ? 'You' : w.who;
  const parts = (w.why ?? '').split(' · ').filter(Boolean);
  if (w.who === viewer && w.kind === 'question' && parts.length > 1) return `${who} · ${parts.length} questions from ${agentName(task.delegate)}`;
  if (w.who === viewer && w.kind === 'review') return `${who} · a result to review`;
  if (w.who === viewer && w.kind === 'do') return w.why ? `Your move · ${w.why}` : 'Your move';
  return w.why ? `${who} · ${w.why}` : who;
}

/**
 * A task's mode (decision session-kind-follows-task-delegate): handed to an agent (it names a delegate), the agent
 * works on it alone; else it is with its owner. Only Delegate and Take over change it.
 */
export type TaskMode = 'alone' | 'with_you';
export const taskMode = (task: Pick<BoardTask, 'delegate'>): TaskMode => (task.delegate ? 'alone' : 'with_you');

/** The mode in a few words, for the chip next to a session's task: "With you" or "Atlas works alone". */
export const modeLabel = (task: Pick<BoardTask, 'delegate'>): string => (task.delegate ? `${agentName(task.delegate)} works alone` : 'With you');

/** The name a session's task has until the work is clear (host domain/task-title.ts PLACEHOLDER_TITLE). */
const PLACEHOLDER_TITLE = /^session-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;

/** Delegate is offered only on a task with a name and a goal: an agent alone needs to know what done means. */
export const canDelegate = (task: Pick<BoardTask, 'title' | 'displayTitle' | 'goal'>): boolean =>
  Boolean(task.goal?.trim()) && !(PLACEHOLDER_TITLE.test(task.title) && !task.displayTitle?.trim());

export type PanelAction = 'looks_good' | 'hand_to' | 'run_now' | 'delegate_now' | 'schedule' | 'together' | 'take_over';

/** Working on the task yourself: Take over on a task the agent works on alone with its own session, Work on it now on one without a session. */
function workAction(task: BoardTask): Array<'together' | 'take_over'> {
  if (task.delegate) return [task.ownSession ? 'take_over' : 'together'];
  return task.ownSession ? [] : ['together'];
}

/** The actions that hand the task to an agent alone, which the host refuses on a task without a name or a goal. */
const DELEGATING = new Set<PanelAction>(['hand_to', 'run_now', 'delegate_now', 'schedule']);

/** The actions a task's state calls for: none while an agent asks (the chat answers), Hand to after Work on it now, … */
export function panelActions(task: BoardTask, hasSession: boolean): PanelAction[] {
  const ready = canDelegate(task);
  return actionsFor(task, hasSession).filter((a) => ready || !DELEGATING.has(a));
}

function actionsFor(task: BoardTask, hasSession: boolean): PanelAction[] {
  // Asked: the answer goes into the chat. With its session gone, work on it or run the agent again (the question goes along).
  if (task.group === 'asked') return hasSession ? [] : ['together', 'run_now'];
  // Open steps: it cannot be closed yet (the host refuses it at the click), so Looks good is not offered.
  if (task.turn === 'review') return hasOpenSteps(task) ? [] : ['looks_good'];
  // Waiting on its steps: they move it; the owner can still work on it.
  if (task.group === 'steps') return workAction(task);
  if (task.handTo) return ['hand_to', 'schedule', ...workAction(task)];
  if (task.turn === 'agent_working' && task.group !== 'stale') return workAction(task);
  if (task.turn === 'parked') return [];
  if (task.delegate) {
    // Scheduled: the Delegate line changes the schedule; run it now or work on it.
    if (task.nextRunAt || task.schedule) return ['run_now', ...workAction(task)];
    return ['run_now', 'schedule', ...workAction(task)];
  }
  return ['delegate_now', 'schedule', ...workAction(task)];
}

