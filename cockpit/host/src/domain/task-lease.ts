import { LONG_CONTEXT_TOKENS } from './own-session.js'
import type { SpawnRequest } from './spawn-request.js'

/**
 * One live session per task: the task's lease. Whoever holds it is the one place work on the task goes; every way a
 * session can start on a task asks here first, so a task never gets a second session beside the first.
 *
 * The lease holder is, in this order:
 *   - a pending request bound to the task in the spawn queue (spawn-queue.ts): a session about to start on it. No
 *     ledger entry exists for it until it starts, so without this the queue and the ledger would each think the task
 *     is free;
 *   - else the task's newest session that is not put away and is not a scheduled run. Idle and stopped sessions hold
 *     it too: a message to a stopped session resumes it (application/deliver-message.ts).
 *
 * Helpers count here, unlike the task's own session that a hand-over continues (domain/own-session.ts ownSessionOf,
 * which skips sessions with a parent session or a job). A worker a session started with --task on a task that had no
 * holder is still a helper (it shows under its parent), yet it is the one session on the task: if the lease skipped
 * it, the next start would add a second session. Delegate continues only the own session (ownSessionOf).
 *
 * Scheduled runs (origin 'job', a jobId) keep a session per run: they never hold the lease, are never revoked and
 * never redirected.
 *
 * Each entry point says what it does when the lease is held (like a workflow id conflict policy):
 *   - the task runner (origin 'runner') uses the existing holder: it continues the own session itself
 *     (application/task-runner.ts) and never queues a second request;
 *   - the user's own start on a task (origin 'task') supersedes a pending runner request: the user is there, so the
 *     runner's unattended start is revoked. A second own start while one is pending uses that one;
 *   - a split onto a task (origin 'split') supersedes a pending runner request too;
 *   - a session's worker on an existing task (spawn-api.ts) goes to the holding session as a message instead.
 * A queued runner request is checked once more when it becomes a process (worker-start.ts, the claim in
 * spawn-api.ts): one that went stale meanwhile is dropped (staleRunnerRequest).
 */

/** What the lease reads of a session in the ledger. */
export interface LeaseSession {
  sessionId: string
  taskId: string | null
  createdAt: string
  archived: boolean
  jobId: string | null
}

type LeaseRequest = Pick<SpawnRequest, 'id' | 'taskId' | 'origin' | 'jobId' | 'createdAt'>

/** The request takes the task's lease: it is bound to a task and is not a scheduled run. */
export function takesLease(request: Pick<SpawnRequest, 'taskId' | 'origin' | 'jobId'>): boolean {
  return Boolean(request.taskId) && request.origin !== 'job' && !request.jobId
}

/** The oldest pending request that holds the task's lease, or null. */
export function pendingHolder<R extends LeaseRequest>(pending: readonly R[], taskId: string): R | null {
  return pending.filter((r) => r.taskId === taskId && takesLease(r))
    .reduce<R | null>((oldest, r) => (!oldest || r.createdAt < oldest.createdAt ? r : oldest), null)
}

/** The task's newest session that holds its lease (helpers count, scheduled runs and put-away ones do not), or null. */
export function sessionHolder<S extends LeaseSession>(sessions: readonly S[], taskId: string): S | null {
  return sessions.filter((s) => s.taskId === taskId && !s.archived && !s.jobId)
    .reduce<S | null>((newest, s) => (!newest || Date.parse(s.createdAt) > Date.parse(newest.createdAt) ? s : newest), null)
}

/** A session as the ledger keeps it (session-ledger.ts): put away when it has an archivedAt. */
export interface LeaseEntry {
  sessionId: string
  taskId: string | null
  createdAt: string
  archivedAt: string | null
  jobId: string | null
  title?: string | null
  agentTitle?: string | null
}

/** The ledger entries as the lease reads them. */
export function leaseSessions<E extends LeaseEntry>(entries: readonly E[]): Array<E & LeaseSession> {
  return entries.map((e) => ({ ...e, archived: Boolean(e.archivedAt) }))
}

/** The ledger entry of the session that holds the task's lease, or null. */
export function leaseSessionOf<E extends LeaseEntry>(entries: readonly E[], taskId: string): (E & LeaseSession) | null {
  return sessionHolder(leaseSessions(entries), taskId)
}

/** What a refusal calls the holding session: the user's title, else the agent's, else its id. */
export function holderName(entry: Pick<LeaseEntry, 'sessionId' | 'title' | 'agentTitle'>): string {
  return entry.title ?? entry.agentTitle ?? entry.sessionId
}

export type LeaseHolder<R, S> = { kind: 'request'; request: R } | { kind: 'session'; session: S }

/** Who holds the task's lease: a pending request first, else a session; null when nobody does. */
export function leaseHolder<R extends LeaseRequest, S extends LeaseSession>(pending: readonly R[], sessions: readonly S[], taskId: string): LeaseHolder<R, S> | null {
  const request = pendingHolder(pending, taskId)
  if (request) return { kind: 'request', request }
  const session = sessionHolder(sessions, taskId)
  return session ? { kind: 'session', session } : null
}

/**
 * What the spawn queue does with a new request, given the requests pending now: add it (revoking the pending runner
 * requests it supersedes), or hand back the pending one that already holds the lease.
 */
export type AddDecision<R> = { kind: 'add'; revoke: R[] } | { kind: 'use_existing'; existing: R }

export function decideAdd<R extends LeaseRequest>(incoming: Pick<SpawnRequest, 'taskId' | 'origin' | 'jobId'>, pending: readonly R[]): AddDecision<R> {
  if (!takesLease(incoming)) return { kind: 'add', revoke: [] }
  const onTask = pending.filter((r) => r.taskId === incoming.taskId && takesLease(r))
  if (incoming.origin === 'runner') {
    const existing = pendingHolder(onTask, incoming.taskId!)
    return existing ? { kind: 'use_existing', existing } : { kind: 'add', revoke: [] }
  }
  if (incoming.origin === 'task' || incoming.origin === 'split') {
    const revoke = onTask.filter((r) => r.origin === 'runner')
    const own = incoming.origin === 'task' ? pendingHolder(onTask.filter((r) => r.origin === 'task'), incoming.taskId!) : null
    return own ? { kind: 'use_existing', existing: own } : { kind: 'add', revoke }
  }
  // A session's worker or a task run from the page: the caller checked the lease in the same tick
  // (application/task-lease.ts routeToTaskHolder, takenSince).
  return { kind: 'add', revoke: [] }
}

/** What the fencing check reads about a task when one of its queued runner requests is about to start. */
export interface StaleFacts {
  /** The owner works on it now or took it over (application/task-commands.ts together). */
  together: boolean
  /** A hand-over of it can still be undone, or one was undone after the request was queued. */
  held: boolean
  /** The task's lease-holding session, if any. */
  session: Pick<LeaseSession, 'sessionId' | 'createdAt'> | null
}

/**
 * Why a queued runner request must not start any more, or null when it still may. Only runner requests go stale: the
 * user's own starts and session workers are what the user or a session asked for just now.
 */
export function staleRunnerRequest(request: Pick<SpawnRequest, 'id' | 'origin' | 'createdAt'>, facts: StaleFacts): string | null {
  if (request.origin !== 'runner') return null
  if (facts.together) return 'the owner works on the task now'
  if (facts.held) return 'its hand-over was changed or undone'
  const session = facts.session
  if (session && session.sessionId !== request.id && Date.parse(session.createdAt) >= Date.parse(request.createdAt)) {
    return `session ${session.sessionId.slice(0, 8)} started on the task meanwhile`
  }
  return null
}

/**
 * Whether a session's worker for a task that a session holds goes to that session as a message (deliver), or the
 * holder is put away and the worker starts in its place (replace): its context is very long, where carrying on soon
 * means compaction (domain/own-session.ts LONG_CONTEXT_TOKENS). Either way one session is left on the task.
 */
export function routeToHolder(contextTokens: number | null): 'deliver' | 'replace' {
  return contextTokens !== null && contextTokens >= LONG_CONTEXT_TOKENS ? 'replace' : 'deliver'
}
