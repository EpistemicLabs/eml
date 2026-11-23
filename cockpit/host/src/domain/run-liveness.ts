/**
 * Synced run records (brain schema 23, step 3 of the task state migration).
 *
 * A run is one session on a task, as its member's cockpit knows it. The host writes one per session
 * on a task (application/run-records.ts), and every member's board and runner read them, so "who
 * works on this right now" no longer lives only in one cockpit's session ledger. A run counts as live
 * while it is not ended and its lease has not run out: the writing host renews the lease every
 * RUN_RENEW_MS to RUN_LEASE_MS ahead while the session's process runs, so a host that is gone stops
 * counting once its lease is over. The local ledger fills in for sessions without a run (a member on
 * older logic, a write that failed): this host's own sessions always come from it.
 */

import type { LiveFacts } from './task-turn.js'
import type { TurnState } from './agent-provider.js'

/** How far ahead a renewal sets lease_until. One constant: a relay presence frame may replace it later. */
export const RUN_LEASE_MS = 15 * 60 * 1000
/** How often a live run's lease is renewed: the lease then always has 10 minutes or more left. */
export const RUN_RENEW_MS = 5 * 60 * 1000

export type RunState = 'running' | 'idle' | 'awaiting_input' | 'ended'
export type RunOrigin = 'user' | 'runner' | 'job'
export type RunDriver = 'human' | 'agent'

/** A run as the brain lists it (GET /object/run), read tolerantly. */
export interface RunFacts {
  id: string
  task_id: string
  member: string
  agent?: string | null
  state: string
  lease_until?: string | null
}

/** Rows of GET /object/run as runs; anything without an id, task, member or state is left out. */
export function runsOf(objects: ReadonlyArray<Record<string, unknown>>): RunFacts[] {
  return objects.filter((o): o is Record<string, unknown> & RunFacts =>
    typeof o.id === 'string' && typeof o.task_id === 'string' && typeof o.member === 'string' && typeof o.state === 'string')
}

/** The run is not ended and its lease reaches past `now`. A run without a lease is not live: nobody renews it. */
export function isLive(run: RunFacts, now: number): boolean {
  if (run.state === 'ended' || !run.lease_until) return false
  const until = Date.parse(run.lease_until)
  return Number.isFinite(until) && until > now
}

/** The live runs, by task. */
export function liveRunsByTask(runs: readonly RunFacts[], now: number): Map<string, RunFacts[]> {
  const byTask = new Map<string, RunFacts[]>()
  for (const run of runs) {
    if (!isLive(run, now)) continue
    const list = byTask.get(run.task_id) ?? []
    list.push(run)
    byTask.set(run.task_id, list)
  }
  return byTask
}

/**
 * What the board knows about a task right now: this host's sessions on it (the ledger, never put
 * away) and the live runs of sessions it does not have, one per session id. A run is working while
 * it is running. `nextRunAt` is a job's next run here, else the one mirrored into the task's
 * delegation by the member whose job it is.
 */
export function liveFactsOf(
  local: ReadonlyArray<{ sessionId: string; working: boolean }>,
  runs: readonly RunFacts[],
  nextRunAt: string | null,
): LiveFacts {
  const known = new Set(local.map((s) => s.sessionId))
  const remote = runs.filter((r) => !known.has(r.id))
  return {
    working: local.some((s) => s.working) || remote.some((r) => r.state === 'running'),
    sessions: local.length + remote.length,
    nextRunAt,
  }
}

/** A live run of a session this host does not have keeps the runner from starting the task: someone works on it elsewhere. */
export function runsBlockRunner(runs: readonly RunFacts[], localSessionIds: ReadonlySet<string>): boolean {
  return runs.some((r) => !localSessionIds.has(r.id))
}

/** The next run mirrored into a task's delegation, when it is still ahead. */
export function delegatedNextRun(delegation: { next_run_at?: unknown } | null | undefined, now: number): string | null {
  const at = delegation?.next_run_at
  if (typeof at !== 'string') return null
  const t = Date.parse(at)
  return Number.isFinite(t) && t > now ? at : null
}

/** A session's turn as a run state: in a turn → running, asking the human → awaiting_input, else idle. */
export function runStateOf(turn: TurnState | undefined): Exclude<RunState, 'ended'> {
  if (turn === 'working') return 'running'
  if (turn === 'waiting') return 'awaiting_input'
  return 'idle'
}

/** Who started a session and who drives it, from its ledger entry. */
export function runOriginOf(entry: { jobId: string | null; worker: boolean; parentSessionId: string | null }): { origin: RunOrigin; driver: RunDriver } {
  if (entry.jobId) return { origin: 'job', driver: 'agent' }
  // The runner starts its workers without a parent session; a session that opens a worker is its parent.
  if (entry.worker) return { origin: entry.parentSessionId ? 'user' : 'runner', driver: 'agent' }
  return { origin: 'user', driver: 'human' }
}

/** The same instant, whatever the ISO form (the brain stores milliseconds and Z). */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return Date.parse(a) === Date.parse(b)
}
