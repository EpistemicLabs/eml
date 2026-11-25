import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import type { TurnState } from '../domain/agent-provider.js'
import { runIdOf, runOriginOf, runStateOf, runsOf, sessionOfRun, type RunEndReason, type RunState } from '../domain/runs.js'

/**
 * Synced run records (domain/runs.ts): this host writes a run for each of its sessions on a
 * task, so every member's board and runner see who works on what.
 *
 * A run is written only when something happens, never as a heartbeat (every write is an op the shared log keeps):
 *   - created once the session's process runs or it is in a turn, with its state;
 *   - its state follows the turn: running while in a turn, idle between turns, with the result line of its last
 *     handoff when that changed (the brain stamps last_activity_at on every write);
 *   - ended put_away when the session is put away, finished when it leaves the ledger;
 *   - ended crashed when the host starts and finds one of its member's open runs without a live session;
 *   - an ended run whose session runs again is resumed (the same run: it is the same session);
 *   - a session a delegation continued (application/task-runner.ts) gets a new run from then: the earlier one ends
 *     finished, and the new one has an id and a start of its own (domain/runs.ts runIdOf), so its start closes the
 *     delegation's request as a new session's run would.
 * Sync compares this host's sessions with what it wrote and writes the difference; with nothing changed it writes
 * nothing. The brain is read once per space, at the first sync after the host started. A run's task is fixed: a session
 * moved to another task ends its run and is left to the ledger. A write the brain refuses (no such task in it, another
 * handle) is logged once and the session stays with the ledger. A brain without runs (before schema 23) gets no writes.
 */

export interface RunSession {
  sessionId: string
  taskId: string | null
  /** The space it runs in, resolved (null in the ledger is the main space). */
  spaceId: string
  createdAt: string
  archived: boolean
  jobId: string | null
  worker: boolean
  parentSessionId: string | null
  /** When its current run started, when later than the session (a delegation continued it); null: its first run. */
  runStartedAt: string | null
}

export interface RunRecordsDeps {
  spaces(): BrainSpace[]
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post' | 'put'> | null
  /** This cockpit's member: the run's member, the only one who may write it. */
  me: string
  sessions(): RunSession[]
  turnOf(sessionId: string): TurnState | undefined
  /** The session's process runs (a terminal or the chat runtime). */
  processRuns(sessionId: string): boolean
  /** The result line of the session's last handoff, if it gave one. */
  resultOf(sessionId: string): string | null
  /** The agent the space's sessions run as. */
  agentOf(space: BrainSpace): string | null
  log(line: string): void
}

interface Written {
  /** The id of the session's run as written (domain/runs.ts sessionOfRun). */
  runId: string
  spaceId: string
  taskId: string
  state: RunState
  result: string | null
}

export interface RunRecords {
  /** Bring the brain in line with this host's sessions; one at a time. */
  sync(): Promise<void>
  /** Sync soon (a turn changed): several asks in a row make one sync. */
  poke(): void
  /** Syncs every `ms`; returns the stop. */
  every(ms: number): () => void
}

export function createRunRecords(deps: RunRecordsDeps, opts: { pokeMs?: number } = {}): RunRecords {
  /** What this host wrote, by session id. */
  const written = new Map<string, Written>()
  /** Sessions the brain refused a run for, with the run's id: the ledger covers that run. A later run is tried again. */
  const refused = new Map<string, string>()
  /** Spaces whose runs of this member were read after the host started. */
  const loaded = new Set<string>()
  /** Spaces whose runs could not be read, logged once (a brain from before schema 23). */
  const unreadable = new Set<string>()
  let running: Promise<void> | null = null
  let pokeTimer: NodeJS.Timeout | null = null

  const refuse = (sessionId: string, runId: string, why: string) => {
    if (refused.get(sessionId) === runId) return
    refused.set(sessionId, runId)
    deps.log(`[runs] no run for session ${sessionId.slice(0, 8)}: ${why}`)
  }

  const live = (sessionId: string) => {
    const turn = deps.turnOf(sessionId)
    return deps.processRuns(sessionId) || turn === 'working' || turn === 'waiting'
  }

  const put = async (brain: Pick<EmlApi, 'put'>, sessionId: string, prev: Written, patch: { state: RunState; end_reason?: RunEndReason; result?: string }) => {
    await brain.put(`/object/run/${encodeURIComponent(prev.runId)}`, patch)
    written.set(sessionId, { ...prev, state: patch.state, result: patch.result ?? prev.result })
  }

  /** This member's runs that are not ended, as the brain has them. One without a live session crashed with the host. */
  const load = async (space: BrainSpace, brain: Pick<EmlApi, 'get' | 'put'>) => {
    const listed = await brain.get('/object/run') as { objects?: Array<Record<string, unknown>> }
    loaded.add(space.id)
    for (const run of runsOf(listed.objects ?? [])) {
      const sessionId = sessionOfRun(run.id)
      if (run.member !== deps.me || written.has(sessionId)) continue
      const prev: Written = { runId: run.id, spaceId: space.id, taskId: run.task_id, state: run.state as RunState, result: run.result ?? null }
      written.set(sessionId, prev)
      if (run.state !== 'ended' && !live(sessionId)) {
        await put(brain, sessionId, prev, { state: 'ended', end_reason: 'crashed' })
          .catch((err: Error) => deps.log(`[runs] session ${sessionId.slice(0, 8)}: ${err.message}`))
      }
    }
  }

  const create = async (brain: Pick<EmlApi, 'get' | 'post'>, space: BrainSpace, s: RunSession & { taskId: string }, state: Exclude<RunState, 'ended'>, result: string | null) => {
    const runId = runIdOf(s.sessionId, s.runStartedAt)
    // This run may be there already (it ended before this host started): carry on with it, don't create it.
    const found = (await brain.get(`/object/run/${encodeURIComponent(runId)}`).catch(() => null)) as { object?: Record<string, unknown> } | null
    const existing = found?.object ? runsOf([found.object])[0] : undefined
    if (existing) {
      if (existing.member === deps.me && existing.task_id === s.taskId) {
        written.set(s.sessionId, { runId, spaceId: space.id, taskId: existing.task_id, state: existing.state as RunState, result: existing.result ?? null })
        return false
      }
      refuse(s.sessionId, runId, `run ${runId} belongs to ${existing.member} on task ${existing.task_id}`)
      return true
    }
    const agent = deps.agentOf(space)
    try {
      await brain.post('/object/run', {
        id: runId, task_id: s.taskId, member: deps.me, ...(agent ? { agent } : {}), ...runOriginOf(s),
        state, started_at: s.runStartedAt ?? s.createdAt, ...(result ? { result } : {}),
      })
      written.set(s.sessionId, { runId, spaceId: space.id, taskId: s.taskId, state, result })
    } catch (err) {
      refuse(s.sessionId, runId, (err as Error).message)
    }
    return true
  }

  const syncRuns = async (space: BrainSpace, brain: Pick<EmlApi, 'get' | 'post' | 'put'>) => {
    const sessions = deps.sessions().filter((s) => s.spaceId === space.id)
    const present = new Set(sessions.map((s) => s.sessionId))
    for (const s of sessions) {
      const runId = runIdOf(s.sessionId, s.runStartedAt)
      if (!s.taskId || refused.get(s.sessionId) === runId) continue
      // A refusal covers the run it was for; the session's later run (a delegation continued it) is written again.
      refused.delete(s.sessionId)
      try {
        let prev = written.get(s.sessionId)
        // A delegation continued the session: its earlier run ends, and the new one is written as any first run is.
        if (prev && prev.runId !== runId && !s.archived) {
          if (prev.state !== 'ended') await put(brain, s.sessionId, prev, { state: 'ended', end_reason: 'finished' })
          written.delete(s.sessionId)
          prev = undefined
        }
        if (prev && prev.taskId !== s.taskId) {
          if (prev.state !== 'ended') await put(brain, s.sessionId, prev, { state: 'ended', end_reason: 'finished' })
          refuse(s.sessionId, runId, 'it moved to another task (a run keeps its task)')
          continue
        }
        if (s.archived) {
          if (prev && prev.state !== 'ended') await put(brain, s.sessionId, prev, { state: 'ended', end_reason: 'put_away' })
          continue
        }
        const isLive = live(s.sessionId)
        const state = runStateOf(deps.turnOf(s.sessionId))
        const result = deps.resultOf(s.sessionId)
        if (!prev) {
          if (!isLive) continue
          if (await create(brain, space, { ...s, taskId: s.taskId }, state, result)) continue
          prev = written.get(s.sessionId)
          if (!prev) continue
        }
        const resultChanged = result !== null && result !== prev.result
        if (isLive) {
          // Running or idle as the turn says; an ended run whose session runs again is resumed.
          if (state !== prev.state || resultChanged) await put(brain, s.sessionId, prev, { state, ...(resultChanged ? { result } : {}) })
        } else if (prev.state === 'running') {
          // Its process is gone mid-turn: idle until it runs again, is put away or the host restarts.
          await put(brain, s.sessionId, prev, { state: 'idle', ...(resultChanged ? { result } : {}) })
        } else if (prev.state === 'idle' && resultChanged) {
          await put(brain, s.sessionId, prev, { state: 'idle', result })
        }
      } catch (err) {
        deps.log(`[runs] session ${s.sessionId.slice(0, 8)}: ${(err as Error).message}`)
      }
    }
    // A run whose session left the ledger ends.
    for (const [sessionId, prev] of written) {
      if (prev.spaceId !== space.id || prev.state === 'ended' || present.has(sessionId)) continue
      await put(brain, sessionId, prev, { state: 'ended', end_reason: 'finished' })
        .catch((err: Error) => deps.log(`[runs] session ${sessionId.slice(0, 8)}: ${err.message}`))
    }
  }

  const syncOnce = async () => {
    for (const space of deps.spaces()) {
      const brain = deps.brain(space)
      if (!brain) continue
      try {
        if (!loaded.has(space.id)) await load(space, brain)
      } catch (err) {
        // A brain from before schema 23 has no runs: try again next time, write nothing now.
        if (!unreadable.has(space.id)) deps.log(`[runs] ${space.name}: runs not readable — ${(err as Error).message}`)
        unreadable.add(space.id)
        continue
      }
      await syncRuns(space, brain)
    }
  }

  const records: RunRecords = {
    async sync() {
      while (running) await running
      running = syncOnce().finally(() => { running = null })
      return running
    },
    poke() {
      if (pokeTimer) return
      pokeTimer = setTimeout(() => { pokeTimer = null; void records.sync() }, opts.pokeMs ?? 1000)
      pokeTimer.unref?.()
    },
    every(ms) {
      const timer = setInterval(() => { void records.sync() }, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }
  return records
}
