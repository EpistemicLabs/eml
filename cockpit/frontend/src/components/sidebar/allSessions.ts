// The sidebar's sessions sorted into its sections: what needs an answer, what is
// finished and waits to be looked at, the main sessions with their workers under
// them, and the rest. Pure, so the rules (no session twice, a worker under its top
// session, finished work staying until archived) are tested without a browser.
import type { SpaceInfo } from '@/stores/useSpaceStore';
import type { TurnInfo, TurnState } from '@/stores/useTurnStateStore';
import type { ProjectSession } from '@/types/app';

/** A session as GET /api/sessions/all returns it. */
export type AllSession = ProjectSession & { spaceId: string };

/** A worker waiting for free memory: it has no session yet (GET /api/sessions/all). */
export type QueuedWorker = { id: string; parentSessionId: string };

export interface AgentGroup {
  space: SpaceInfo;
  sessions: AllSession[];
}

export interface WorkerCounts {
  working: number;
  queued: number;
  toReview: number;
  needsYou: number;
  finished: number;
  /** Minutes the quietest working one has said nothing; null while none is quiet. */
  quietMinutes: number | null;
}

/** A main session and the workers below it, however deep they were started. */
export interface MainItem {
  session: AllSession;
  workers: AllSession[];
  counts: WorkerCounts;
}

export interface AllSections {
  needsYou: AllSession[];
  toReview: AllSession[];
  main: Array<{ space: SpaceInfo; items: MainItem[] }>;
  recent: AgentGroup[];
  /** Workers under their parent: no row of their own, but search finds them. */
  searchOnly: AllSession[];
}

const RECENT_MS = 24 * 60 * 60 * 1000;
const QUIET_MS = 30 * 60 * 1000;

/** What a session's row says about it; null: nothing, it reads as a plain row. */
export type SessionMark = 'question' | 'failed' | 'waiting' | 'review' | 'done';

const NEEDS_YOU: readonly SessionMark[] = ['question', 'failed', 'waiting'];

export const MARK_WORD: Record<SessionMark, string> = {
  question: 'Question',
  failed: 'Failed',
  waiting: 'Waiting for you',
  review: 'Check this',
  done: 'Reports done',
};

export const MARK_SYMBOL: Record<SessionMark, string> = {
  question: '?',
  failed: '!',
  waiting: '?',
  review: '●',
  done: '●',
};

/** What a space's sessions are labelled with: its agent, else the space's name (host spaceLabel). */
export const agentLabel = (space: SpaceInfo): string => space.label ?? space.name;

export const agentLetter = (space: SpaceInfo): string => agentLabel(space).charAt(0).toUpperCase();

/**
 * The turn state to show. The host keeps a session's last state after its
 * process ended, so an ended session counts as idle here.
 */
export function allSessionState(session: ProjectSession, turn: TurnInfo | undefined): TurnState {
  if (session.state === 'ended') return 'idle';
  return turn?.state ?? session.turnState ?? 'idle';
}

/**
 * How the session stands for the user. What a worker reported is saved and holds
 * after its process stopped; only a new turn or the user's own action ends it.
 */
export function sessionMark(session: ProjectSession, turn: TurnInfo | undefined): SessionMark | null {
  const state = allSessionState(session, turn);
  if (state === 'working') return null;
  if (session.attention) return session.attention.kind;
  return state === 'waiting' ? 'waiting' : null;
}

/** Whether the user has opened it since it reported. Marks the row as read; it stays listed. */
export function isRead(session: ProjectSession): boolean {
  const { attention, readAt } = session;
  return Boolean(attention && readAt && readAt >= attention.at);
}

const activityOf = (session: ProjectSession) => session.lastActivity ?? session.createdAt ?? '';
const newestFirst = (a: ProjectSession, b: ProjectSession) => activityOf(b).localeCompare(activityOf(a));
// Oldest first and not by activity: a row keeps its place while its session works.
const stableOrder = (a: AllSession, b: AllSession) =>
  (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id);

/** The session at the top of a worker's line of parents; the session itself when its parent left the list. */
function topSession(session: AllSession, live: Map<string, AllSession>): AllSession {
  const seen = new Set([session.id]);
  let top = session;
  for (;;) {
    const parent = top.parentSessionId ? live.get(top.parentSessionId) : undefined;
    if (!parent || seen.has(parent.id)) return top;
    seen.add(parent.id);
    top = parent;
  }
}

const quietMinutes = (session: AllSession, now: number): number | null => {
  const quiet = now - Date.parse(activityOf(session));
  return quiet >= QUIET_MS ? Math.floor(quiet / 60_000) : null;
};

/** What the parent's row counts. */
export function workerCounts(
  workers: AllSession[],
  queued: number,
  turns: Record<string, TurnInfo>,
  now: number,
): WorkerCounts {
  const counts: WorkerCounts = { working: 0, queued, toReview: 0, needsYou: 0, finished: 0, quietMinutes: null };
  for (const worker of workers) {
    const mark = sessionMark(worker, turns[worker.id]);
    if (mark && NEEDS_YOU.includes(mark)) counts.needsYou += 1;
    else if (mark) counts.toReview += 1;
    else if (allSessionState(worker, turns[worker.id]) === 'working') {
      counts.working += 1;
      const quiet = quietMinutes(worker, now);
      if (quiet !== null) counts.quietMinutes = Math.max(counts.quietMinutes ?? 0, quiet);
    } else counts.finished += 1;
  }
  return counts;
}

/** The counts in words, for the parent's row; empty when it has no workers. */
export function countsLine(counts: WorkerCounts): string {
  const parts = [
    counts.needsYou > 0 && `${counts.needsYou} need${counts.needsYou === 1 ? 's' : ''} you`,
    counts.toReview > 0 && `${counts.toReview} to review`,
    counts.working > 0 && `${counts.working} working`,
    counts.queued > 0 && `${counts.queued} queued`,
    counts.finished > 0 && `${counts.finished} finished`,
    counts.quietMinutes !== null && `quiet ${counts.quietMinutes}m`,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Each session in exactly one section; spaces keep the order of the space list. */
export function groupAllSessions(
  sessions: AllSession[],
  spaces: SpaceInfo[],
  turns: Record<string, TurnInfo>,
  isPinned: (session: ProjectSession) => boolean,
  now: number = Date.now(),
  queued: QueuedWorker[] = [],
): AllSections {
  const empty: AllSections = { needsYou: [], toReview: [], main: [], recent: [], searchOnly: [] };
  if (spaces.length === 0) return empty;
  const live = new Map(sessions.filter((session) => !session.archivedAt).map((session) => [session.id, session]));
  const workersOf = new Map<string, AllSession[]>();
  const tops: AllSession[] = [];
  for (const session of live.values()) {
    const top = topSession(session, live);
    if (top === session) tops.push(session);
    else workersOf.set(top.id, [...(workersOf.get(top.id) ?? []), session]);
  }
  const queuedOf = new Map<string, number>();
  for (const { parentSessionId } of queued) {
    const parent = live.get(parentSessionId);
    if (!parent) continue;
    const top = topSession(parent, live);
    queuedOf.set(top.id, (queuedOf.get(top.id) ?? 0) + 1);
  }

  const needsYou: AllSession[] = [];
  const toReview: AllSession[] = [];
  const main: AllSession[] = [];
  // Archived sessions read like any older chat: they only leave the sections above.
  const recent = sessions.filter((session) => session.archivedAt);
  const searchOnly: AllSession[] = [];
  for (const session of live.values()) {
    const turn = turns[session.id];
    const mark = sessionMark(session, turn);
    const state = allSessionState(session, turn);
    const hasWorkers = (workersOf.get(session.id)?.length ?? 0) > 0 || queuedOf.has(session.id);
    const isTop = topSession(session, live) === session;
    if (mark && NEEDS_YOU.includes(mark)) needsYou.push(session);
    else if (mark) toReview.push(session);
    else if (!isTop) searchOnly.push(session);
    else if (isPinned(session) || state === 'working' || session.state === 'running') main.push(session);
    else if (hasWorkers && workersOf.get(session.id)?.some((worker) => allSessionState(worker, turns[worker.id]) === 'working' || sessionMark(worker, turns[worker.id]))) main.push(session);
    else if (queuedOf.has(session.id)) main.push(session);
    else if (!session.worker && now - Date.parse(activityOf(session)) < RECENT_MS) main.push(session);
    else recent.push(session);
  }

  const byAgent = (list: AllSession[], order: (a: AllSession, b: AllSession) => number): AgentGroup[] =>
    spaces
      .map((space) => ({ space, sessions: list.filter((session) => session.spaceId === space.id).sort(order) }))
      .filter((group) => group.sessions.length > 0);
  // Pinned first in its agent's group, each part in a stable order.
  const pinnedFirst = (a: AllSession, b: AllSession) =>
    Number(isPinned(b)) - Number(isPinned(a)) || stableOrder(a, b);
  // Unread first, then what the worker wants checked over what it reports as done.
  const reviewOrder = (a: AllSession, b: AllSession) =>
    Number(isRead(a)) - Number(isRead(b))
    || Number(a.attention?.kind === 'done') - Number(b.attention?.kind === 'done')
    || newestFirst(a, b);

  return {
    needsYou: needsYou.sort(newestFirst),
    toReview: toReview.sort(reviewOrder),
    main: byAgent(main, pinnedFirst).map(({ space, sessions: list }) => ({
      space,
      items: list.map((session) => {
        const workers = (workersOf.get(session.id) ?? []).slice().sort(stableOrder);
        return { session, workers, counts: workerCounts(workers, queuedOf.get(session.id) ?? 0, turns, now) };
      }),
    })),
    recent: byAgent(recent, newestFirst),
    searchOnly,
  };
}

/** The sessions whose name holds `query` (any case); all of them when it is blank. */
export function filterByName(sessions: AllSession[], query: string): AllSession[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return sessions;
  return sessions.filter((session) => (session.summary ?? '').toLowerCase().includes(wanted));
}
