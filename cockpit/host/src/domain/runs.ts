/**
 * Synced run records (brain schema 23).
 *
 * A run is one session on a task, as its member's cockpit knows it. The host writes one per session on a task
 * (application/run-records.ts) when something happens in it — the start, each turn's start and end, the end, a crash
 * found at a restart — and every member's board and runner read them, so each knows who works on a task right now. There is no heartbeat and no lease: only the owner's cockpit runs a task, so
 * nobody takes one over. A run that says running but has had no activity for STALE_MS reads as stale, not working.
 * The local ledger stays the source for this host's own sessions.
 */

import type { LiveFacts } from './task-turn.js'
import type { TurnState } from './agent-provider.js'

/** A running run without activity for this long reads as stale: its host may be gone. One setting, one place. */
export const STALE_MS = 60 * 60 * 1000

export type RunState = 'running' | 'idle' | 'ended'
export type RunOrigin = 'user' | 'runner' | 'job'
export type RunDriver = 'human' | 'agent'
export type RunEndReason = 'finished' | 'put_away' | 'failed' | 'crashed'

/** A run as the brain lists it (GET /object/run), read tolerantly. */
export interface RunFacts {
  id: string
  task_id: string
  member: string
  agent?: string | null
  state: string
  started_at?: string | null
  last_activity_at?: string | null
  result?: string | null
}

/**
 * A run's id is its session's id. A later run of the same session (a delegation that continued it, see
 * runIdOf) adds when it started after RUN_SEPARATOR; session ids never contain it.
 */
export const RUN_SEPARATOR = '_'

/** The session a run belongs to. */
export function sessionOfRun(runId: string): string {
  const at = runId.indexOf(RUN_SEPARATOR)
  return at === -1 ? runId : runId.slice(0, at)
}

/** Rows of GET /object/run as runs; anything without an id, task, member or state is left out. */
export function runsOf(objects: ReadonlyArray<Record<string, unknown>>): RunFacts[] {
  return objects.filter((o): o is Record<string, unknown> & RunFacts =>
    typeof o.id === 'string' && typeof o.task_id === 'string' && typeof o.member === 'string' && typeof o.state === 'string')
}

/** Running, but nothing has happened in it for STALE_MS (or it never said when). */
export function isStale(run: RunFacts, now: number): boolean {
  if (run.state !== 'running') return false
  const at = run.last_activity_at ? Date.parse(run.last_activity_at) : NaN
  return !Number.isFinite(at) || now - at > STALE_MS
}

/** Working: running, with activity within STALE_MS. */
export const isWorking = (run: RunFacts, now: number) => run.state === 'running' && !isStale(run, now)

/** The runs that are not ended, by task. */
export function openRunsByTask(runs: readonly RunFacts[]): Map<string, RunFacts[]> {
  const byTask = new Map<string, RunFacts[]>()
  for (const run of runs) {
    if (run.state === 'ended') continue
    const list = byTask.get(run.task_id) ?? []
    list.push(run)
    byTask.set(run.task_id, list)
  }
  return byTask
}

/**
 * What the board knows about a task right now: this host's sessions on it (the ledger, never put away) and the open
 * runs of sessions it does not have, one per session id. A run is working while it runs and is not stale.
 */
export function liveFactsOf(
  local: ReadonlyArray<{ sessionId: string; working: boolean }>,
  runs: readonly RunFacts[],
  nextRunAt: string | null,
  now: number,
): LiveFacts {
  const known = new Set(local.map((s) => s.sessionId))
  const remote = runs.filter((r) => !known.has(sessionOfRun(r.id)) && r.state !== 'ended')
  const working = local.some((s) => s.working) || remote.some((r) => isWorking(r, now))
  return {
    working,
    sessions: local.length + remote.length,
    nextRunAt,
    ...(!working && remote.some((r) => isStale(r, now)) ? { stale: true } : {}),
  }
}

/** A working run of a session this host does not have keeps the runner from starting the task: someone works on it elsewhere. */
export function runsBlockRunner(runs: readonly RunFacts[], localSessionIds: ReadonlySet<string>, now: number): boolean {
  return runs.some((r) => !localSessionIds.has(sessionOfRun(r.id)) && isWorking(r, now))
}

/** A session's turn as a run state: in a turn → running, else idle (a question is a wait on the task, not a run state). */
export function runStateOf(turn: TurnState | undefined): Exclude<RunState, 'ended'> {
  return turn === 'working' ? 'running' : 'idle'
}

/** Who started a session and who drives it, from its ledger entry. */
export function runOriginOf(entry: { jobId: string | null; worker: boolean; parentSessionId: string | null }): { origin: RunOrigin; driver: RunDriver } {
  if (entry.jobId) return { origin: 'job', driver: 'agent' }
  // The runner starts its workers without a parent session; a session that opens a worker is its parent.
  if (entry.worker) return { origin: entry.parentSessionId ? 'user' : 'runner', driver: 'agent' }
  return { origin: 'user', driver: 'human' }
}
