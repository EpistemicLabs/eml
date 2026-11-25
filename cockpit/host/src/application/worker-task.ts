import type { EmlApi } from '@engramprotocol/mcp-server'
import { ownersFor, type OwnedTask } from '../domain/task-owner.js'
import { displayTitleOf, kebabTitle } from './session-task.js'

/**
 * A task the cockpit creates for a spawned worker is handed to the agent with a request
 * (decision session-kind-follows-task-delegate), so it shows as "works alone" and not as "not handed over". The runner
 * must not start a second session next to the worker: between the task's write and the worker's session in the ledger
 * (which then holds the runner, domain/runner-busy.ts) nothing else would.
 *
 * So the hold is taken before the task is written, keyed on the request's time the cockpit writes into it, and bound
 * to the task's id once the brain answers. It lasts WORKER_START_GRACE_MS: by then the worker's session is in the
 * ledger, and its run, which started after the request, closes it. A worker that never started leaves the task to the
 * runner after that time, which then starts it as any delegated task.
 */

export const WORKER_START_GRACE_MS = 10 * 60 * 1000

export interface WorkerTaskHolds {
  /** Hold the task about to be written with this request time; bind it to the task's id once it is written. */
  start(requestedAt: string): { bind(taskId: string): void }
  /** The runner must leave the task alone: a worker is about to start on it. */
  holds(taskId: string, requestedAt?: string | null): boolean
}

export function createWorkerTaskHolds(now: () => number = Date.now): WorkerTaskHolds {
  const held: Array<{ requestedAt: string; taskId: string | null; at: number }> = []
  const prune = () => {
    for (let i = held.length - 1; i >= 0; i--) if (now() - held[i].at >= WORKER_START_GRACE_MS) held.splice(i, 1)
  }
  return {
    start(requestedAt) {
      prune()
      const hold = { requestedAt, taskId: null as string | null, at: now() }
      held.push(hold)
      return { bind: (taskId) => { hold.taskId = taskId } }
    },
    holds(taskId, requestedAt) {
      prune()
      return held.some((h) => h.taskId === taskId || (Boolean(requestedAt) && h.requestedAt === requestedAt))
    },
  }
}

export interface WorkerTaskInput { title: string; content: string; scope: string; fromTaskId?: string }

/**
 * The spawn API's newTask (spawn --new-task), written into the brain at once (decision no-task-triage). Its owners are
 * those of the requester's task, else this cockpit's member (domain/task-owner.ts ownersFor). Its worker works on it
 * alone: the space's agent is its delegate with checkpoint none (the worker closes the task itself and reports to the
 * session that started it), with a request the runner is held off until the worker is on it.
 */
export async function createWorkerTask(
  deps: { brain: Pick<EmlApi, 'get' | 'post'>; owner: string; agent: string | null; holds: Pick<WorkerTaskHolds, 'start'>; now?: () => number },
  input: WorkerTaskInput,
): Promise<{ id: string } | { error: string }> {
  try {
    const origin = input.fromTaskId ? await deps.brain.get(`/engram/${input.fromTaskId}`).catch(() => null) as OwnedTask | null : null
    const display = displayTitleOf(input.title)
    const requestedAt = new Date(deps.now?.() ?? Date.now()).toISOString()
    const hold = deps.agent ? deps.holds.start(requestedAt) : null
    const created = await deps.brain.post('/engram/task', {
      title: kebabTitle(input.title) ?? input.title, ...(display ? { display_title: display } : {}), content: input.content,
      scope: input.scope, status: 'active', assignee_ids: ownersFor(origin, deps.owner),
      ...(deps.agent ? { delegation: { agent: deps.agent, checkpoint: 'none', requested_at: requestedAt } } : {}),
    }) as { id: string }
    hold?.bind(created.id)
    return created
  } catch (err) {
    return { error: (err as Error).message }
  }
}
