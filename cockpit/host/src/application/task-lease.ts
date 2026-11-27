import type { SpawnRequest } from '../domain/spawn-request.js'
import type { DeliveryOutcome } from '../domain/session-delivery.js'
import { holderName, leaseHolder, leaseSessionOf, leaseSessions, pendingHolder, routeToHolder, staleRunnerRequest, type LeaseEntry } from '../domain/task-lease.js'
import type { MessageRequest } from './deliver-message.js'

/**
 * One live session per task (domain/task-lease.ts) against the host's state: the spawn queue's pending requests, the
 * session ledger and the task commands. What the entry points ask before a session starts on a task:
 *   - stale: the fencing check of a queued runner request right before it becomes a process (worker-start.ts and a
 *     tab's claim in spawn-api.ts);
 *   - splitHolder: who a split onto an existing task goes to (application/split-session.ts);
 *   - putAway: a holder with a very long context makes way for a new session, never while it is in a turn;
 *   - routeToTaskHolder and takenSince: a session's worker on an existing task (spawn-api.ts) and a task run from the
 *     page without a desk (POST /api/tasks/run) go to the holding session, or are refused, naming it.
 */

/** What the fencing check reads of the task commands (application/task-commands.ts). */
export interface LeaseCommands {
  together(taskId: string): boolean
  held(taskId: string): boolean
  undoneSince(taskId: string, since: string): boolean
}

export interface TaskLeaseDeps {
  /** The spawn queue's pending requests. */
  pending(): readonly SpawnRequest[]
  /** The session ledger's entries. */
  sessions(): readonly LeaseEntry[]
  /** The task commands, once they exist. */
  commands(): LeaseCommands | null
  /** The session is in a turn right now. */
  working(sessionId: string): boolean
  /** Stop the session and put it away. */
  end(sessionId: string, reason: string): Promise<void>
  /** The session was put away: its wait on the task is over (application/task-router.ts answered). */
  answered(sessionId: string): void
}

export interface TaskLease {
  /** Why a queued request must not start any more, or null when it may (domain/task-lease.ts staleRunnerRequest). */
  stale(request: SpawnRequest): string | null
  /**
   * Who a split onto the task goes to: a session (its id and name), a request still starting on it (`pending`), or
   * null when nobody holds it. A runner request does not count: the split's own request revokes it (spawn-queue.ts).
   */
  splitHolder(taskId: string): { sessionId: string; title: string } | { pending: string } | null
  /** Put a session away so a new one can start in its place; the reason when it cannot be now (it is in a turn). */
  putAway(sessionId: string): Promise<string | null>
}

export function createTaskLease(deps: TaskLeaseDeps): TaskLease {
  return {
    stale(request) {
      if (!request.taskId) return null
      const commands = deps.commands()
      return staleRunnerRequest(request, {
        together: commands?.together(request.taskId) ?? false,
        held: Boolean(commands?.held(request.taskId) || commands?.undoneSince(request.taskId, request.createdAt)),
        session: leaseSessionOf(deps.sessions(), request.taskId),
      })
    },
    splitHolder(taskId) {
      const holder = leaseHolder(deps.pending().filter((r) => r.origin !== 'runner'), leaseSessions(deps.sessions()), taskId)
      if (!holder) return null
      return holder.kind === 'request' ? { pending: holder.request.id } : { sessionId: holder.session.sessionId, title: holderName(holder.session) }
    },
    async putAway(sessionId) {
      if (deps.working(sessionId)) return 'it is in a turn'
      await deps.end(sessionId, 'replaced by a new session on its task')
      deps.answered(sessionId)
      return null
    },
  }
}

/** What routing a start on a task to its holder needs. */
export interface RouteDeps {
  pending(): readonly SpawnRequest[]
  sessions(): readonly LeaseEntry[]
  /** The message endpoint's use case (application/deliver-message.ts). */
  deliver(request: MessageRequest): Promise<DeliveryOutcome>
  /** How full a session's context is; null when unknown. Without it a holder is never replaced. */
  contextTokensOf?(sessionId: string): number | null
  /** Put a session away (TaskLease.putAway); without it a holder is never replaced. */
  putAway?(sessionId: string): Promise<string | null>
}

/** A refusal and whether trying again later can help (a session starting or busy) or never will. */
export interface LeaseRefusal { code: 'TASK_STARTING' | 'TASK_HELD' | 'TASK_HELD_BY_YOU'; message: string; retry: boolean }

/**
 * What came of a start on a task:
 *   free     nobody holds it: start the session (`replaced`: the holder that was put away to make room, or null);
 *   routed   the holding session got the prompt as a message: start nothing;
 *   refused  a request is starting on it, the requester holds it itself, or the holder cannot take the message.
 */
export type RouteOutcome =
  | { kind: 'free'; replaced: string | null }
  | { kind: 'routed'; session: LeaseEntry }
  | { kind: 'refused'; refusal: LeaseRefusal }

/** Why a holder cannot take a message, for the refusal; a busy or running one may take it later. */
const UNREACHABLE: Partial<Record<DeliveryOutcome, string>> = {
  busy: 'it runs in a terminal or is being switched right now',
  refused: 'it cannot be handed a message',
  unknown: 'it could not be found',
  running: 'it runs right now',
}
const RETRY_HELPS = new Set<DeliveryOutcome>(['busy', 'running'])

const starting = (taskId: string, requestId: string): LeaseRefusal => ({
  code: 'TASK_STARTING', retry: true,
  message: `Task ${taskId} already has a session starting (${requestId}); a task has one session at a time. Message that session once it runs instead of starting another.`,
})

/**
 * Route a start on an existing task to the session that holds it:
 *   - a request pending for the task: refused, naming it (it starts soon; message it once it runs). Attaching to it
 *     would mean merging two prompts into one first message, which the requester never sees;
 *   - the requesting session itself holds it: refused for good, a worker beside it would be a second session;
 *   - another session holds it: the prompt goes to it as a message, right away even when it waits on its user; a
 *     holder that cannot take it refuses the start. One whose context is very long is put away and the start goes
 *     ahead in its place, so the task still has one session.
 * `from`: who the message is from, as the holder reads it (the requester's address), or null.
 */
export async function routeToTaskHolder(deps: RouteDeps, input: { taskId: string; prompt: string; fromSessionId: string | null; from: string | null }): Promise<RouteOutcome> {
  const pending = pendingHolder(deps.pending(), input.taskId)
  if (pending) return { kind: 'refused', refusal: starting(input.taskId, pending.id) }
  const holder = leaseSessionOf(deps.sessions(), input.taskId)
  if (!holder) return { kind: 'free', replaced: null }
  const name = holderName(holder)
  if (holder.sessionId === input.fromSessionId) {
    return { kind: 'refused', refusal: { code: 'TASK_HELD_BY_YOU', retry: false, message: `This session already works on task ${input.taskId}, and a task has one session at a time. Give the worker a step of your task (--step) or a task of its own (--new-task) instead.` } }
  }
  if (routeToHolder(deps.contextTokensOf?.(holder.sessionId) ?? null) === 'replace' && deps.putAway) {
    const problem = await deps.putAway(holder.sessionId)
    if (problem) return { kind: 'refused', refusal: { code: 'TASK_HELD', retry: true, message: `Task ${input.taskId} is held by session "${name}" (${holder.sessionId}), whose context is very long, and it cannot be put away now: ${problem}.` } }
    return { kind: 'free', replaced: holder.sessionId }
  }
  const outcome = await deps.deliver({ target: holder.sessionId, text: input.prompt, from: input.from, caller: 'session' })
  if (outcome === 'delivered' || outcome === 'resumed') return { kind: 'routed', session: holder }
  return { kind: 'refused', refusal: { code: 'TASK_HELD', retry: RETRY_HELPS.has(outcome), message: `Task ${input.taskId} is held by session "${name}" (${holder.sessionId}), and ${UNREACHABLE[outcome] ?? outcome}. A task has one session at a time: nothing was started.${RETRY_HELPS.has(outcome) ? ' Try again later.' : ' Ask the user.'}` } }
}

/**
 * The lease once more, right before the add and with no wait in between: whether something took the task since
 * routeToTaskHolder found it free. After a holder was put away (`replaced`), an older session on the task does not
 * count: the start takes the place of the one put away.
 */
export function takenSince(deps: Pick<RouteDeps, 'pending' | 'sessions'>, taskId: string, replaced: string | null): LeaseRefusal | null {
  const pending = pendingHolder(deps.pending(), taskId)
  if (pending) return starting(taskId, pending.id)
  if (replaced === null && leaseSessionOf(deps.sessions(), taskId)) {
    return { code: 'TASK_STARTING', retry: true, message: `Task ${taskId} got a session just now; a task has one session at a time. Try again to reach it.` }
  }
  return null
}
