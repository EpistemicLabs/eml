import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import type { TurnState } from '../domain/agent-provider.js'
import {
  RUN_LEASE_MS, RUN_RENEW_MS, runOriginOf, runStateOf, runsOf, sameInstant, type RunState,
} from '../domain/run-liveness.js'

/**
 * Synced run records (step 3 of the task state migration, domain/run-liveness.ts): this host
 * writes a run for each of its sessions on a task, and mirrors its jobs' next runs into their
 * tasks' delegation, so every member's board and runner see them.
 *
 * Runs. A session on a task gets its run once its process runs (or it is in a turn): created with
 * its state and a lease, written again on every state change (running · idle · awaiting_input) and
 * ended when the session is put away or leaves the ledger. While the process runs the lease is
 * renewed every RUN_RENEW_MS to RUN_LEASE_MS ahead; once it stops, nothing is written and the lease
 * runs out, so the other members stop counting it. A host start picks up its member's runs from
 * the brain and carries on with them. A run's task is fixed: a session moved to another task ends
 * its run and is left to the ledger. A write the brain refuses (no such task in it, another
 * handle) is logged once and the session stays with the ledger.
 *
 * Next runs. Per task with a job here, the earliest next run of its jobs that run (not ended, not
 * held) goes into delegation.next_run_at; when none is left it is cleared. Only tasks with a
 * delegation carry it, and only tasks with a job on this host are touched: another member's
 * mirror is theirs.
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
}

export interface RunJob {
  spaceId: string
  taskId: string | null
  /** Ended or held jobs never run, so they carry no next run. */
  runs: boolean
  nextRunAt: string | null
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
  /** The agent the space's sessions run as. */
  agentOf(space: BrainSpace): string | null
  jobs(): RunJob[]
  now(): number
  log(line: string): void
}

interface Written {
  spaceId: string
  taskId: string
  state: RunState
  leaseUntil: number | null
}

/** How often a task with a job but no delegation is looked at again. */
const NO_DELEGATION_RECHECK_MS = RUN_RENEW_MS

export interface RunRecords {
  /** Bring the brain in line with this host's sessions and jobs; one at a time. */
  sync(): Promise<void>
  /** Sync soon (a turn changed): several asks in a row make one sync. */
  poke(): void
  /** Syncs every `ms`; returns the stop. */
  every(ms: number): () => void
}

export function createRunRecords(deps: RunRecordsDeps, opts: { pokeMs?: number } = {}): RunRecords {
  const written = new Map<string, Written>()
  /** Sessions the brain refused a run for: the ledger covers them. */
  const refused = new Set<string>()
  /** Spaces whose runs of this member were read after the host started. */
  const loaded = new Set<string>()
  /** Per task: the next run last mirrored (or found) and when it was checked. */
  const mirrored = new Map<string, { value: string | null; checkedAt: number; delegated: boolean }>()
  /** Spaces whose runs could not be read, logged once (a brain from before schema 23). */
  const unreadable = new Set<string>()
  let running: Promise<void> | null = null
  let pokeTimer: NodeJS.Timeout | null = null

  const refuse = (sessionId: string, why: string) => {
    if (refused.has(sessionId)) return
    refused.add(sessionId)
    deps.log(`[runs] no run for session ${sessionId.slice(0, 8)}: ${why}`)
  }

  const lease = (now: number) => ({ heartbeat_at: new Date(now).toISOString(), lease_until: new Date(now + RUN_LEASE_MS).toISOString() })

  /** This member's runs that are not ended, as the brain has them: a host start carries on with them. */
  const load = async (space: BrainSpace, brain: Pick<EmlApi, 'get'>) => {
    const listed = await brain.get('/object/run') as { objects?: Array<Record<string, unknown>> }
    for (const run of runsOf(listed.objects ?? [])) {
      if (run.member !== deps.me || written.has(run.id)) continue
      const until = run.lease_until ? Date.parse(run.lease_until) : NaN
      written.set(run.id, { spaceId: space.id, taskId: run.task_id, state: run.state as RunState, leaseUntil: Number.isFinite(until) ? until : null })
    }
    loaded.add(space.id)
  }

  const put = async (brain: Pick<EmlApi, 'put'>, sessionId: string, prev: Written, patch: { state: RunState; heartbeat_at?: string; lease_until?: string | null }) => {
    await brain.put(`/object/run/${encodeURIComponent(sessionId)}`, patch)
    const until = patch.lease_until === undefined ? prev.leaseUntil : patch.lease_until === null ? null : Date.parse(patch.lease_until)
    written.set(sessionId, { ...prev, state: patch.state, leaseUntil: until })
  }

  const syncRuns = async (space: BrainSpace, brain: Pick<EmlApi, 'get' | 'post' | 'put'>, now: number) => {
    const sessions = deps.sessions().filter((s) => s.spaceId === space.id)
    const present = new Set(sessions.map((s) => s.sessionId))
    for (const s of sessions) {
      if (!s.taskId) continue
      const prev = written.get(s.sessionId)
      try {
        if (prev && prev.taskId !== s.taskId) {
          if (prev.state !== 'ended') await put(brain, s.sessionId, prev, { state: 'ended', lease_until: null })
          refuse(s.sessionId, 'it moved to another task (a run keeps its task)')
          continue
        }
        if (s.archived) {
          if (prev && prev.state !== 'ended') await put(brain, s.sessionId, prev, { state: 'ended', lease_until: null })
          continue
        }
        const turn = deps.turnOf(s.sessionId)
        const live = deps.processRuns(s.sessionId) || turn === 'working' || turn === 'waiting'
        const state = runStateOf(turn)
        if (!prev) {
          if (!live || refused.has(s.sessionId)) continue
          const agent = deps.agentOf(space)
          try {
            await brain.post('/object/run', {
              id: s.sessionId, task_id: s.taskId, member: deps.me, ...(agent ? { agent } : {}), ...runOriginOf(s),
              state, started_at: s.createdAt, ...lease(now),
            })
            written.set(s.sessionId, { spaceId: space.id, taskId: s.taskId, state, leaseUntil: now + RUN_LEASE_MS })
          } catch (err) {
            const message = (err as Error).message
            // Ended before this host started (so not loaded) and open again: carry on with it.
            if (/already exists/.test(message)) {
              const found = (await brain.get(`/object/run/${encodeURIComponent(s.sessionId)}`).catch(() => null)) as { object?: Record<string, unknown> } | null
              const run = found?.object ? runsOf([found.object])[0] : undefined
              if (run && run.member === deps.me && run.task_id === s.taskId) {
                written.set(s.sessionId, { spaceId: space.id, taskId: run.task_id, state: run.state as RunState, leaseUntil: null })
                continue
              }
            }
            refuse(s.sessionId, message)
          }
          continue
        }
        if (live) {
          const renew = prev.leaseUntil === null || prev.leaseUntil - now <= RUN_LEASE_MS - RUN_RENEW_MS
          if (state !== prev.state || renew) await put(brain, s.sessionId, prev, { state, ...lease(now) })
        } else if (prev.state !== 'ended' && state !== prev.state) {
          // Its process is gone: the state follows, the lease is left to run out.
          await put(brain, s.sessionId, prev, { state })
        }
      } catch (err) {
        deps.log(`[runs] session ${s.sessionId.slice(0, 8)}: ${(err as Error).message}`)
      }
    }
    // A run whose session left the ledger ends.
    for (const [sessionId, prev] of written) {
      if (prev.spaceId !== space.id || prev.state === 'ended' || present.has(sessionId)) continue
      await put(brain, sessionId, prev, { state: 'ended', lease_until: null })
        .catch((err: Error) => deps.log(`[runs] session ${sessionId.slice(0, 8)}: ${err.message}`))
    }
  }

  const syncNextRuns = async (space: BrainSpace, brain: Pick<EmlApi, 'get' | 'post'>, now: number) => {
    const next = new Map<string, string | null>()
    for (const job of deps.jobs()) {
      if (job.spaceId !== space.id || !job.taskId) continue
      const at = job.runs ? job.nextRunAt : null
      const before = next.get(job.taskId) ?? null
      next.set(job.taskId, at && (!before || Date.parse(at) < Date.parse(before)) ? at : before)
    }
    for (const [taskId, at] of next) {
      const known = mirrored.get(taskId)
      if (known && known.delegated && sameInstant(known.value, at)) continue
      if (known && !known.delegated && now - known.checkedAt < NO_DELEGATION_RECHECK_MS) continue
      try {
        const task = await brain.get(`/engram/${taskId}`) as { status?: string; properties?: { delegation?: Record<string, unknown> } }
        const delegation = task.properties?.delegation
        if (!delegation || typeof delegation.agent !== 'string' || task.status === 'resolved' || task.status === 'invalidated') {
          mirrored.set(taskId, { value: null, checkedAt: now, delegated: false })
          continue
        }
        const current = typeof delegation.next_run_at === 'string' ? delegation.next_run_at : null
        if (!sameInstant(current, at)) {
          const { next_run_at: _drop, ...rest } = delegation
          await brain.post(`/task/${taskId}/track`, { delegation: { ...rest, ...(at ? { next_run_at: at } : {}) } })
        }
        mirrored.set(taskId, { value: at, checkedAt: now, delegated: true })
      } catch (err) {
        deps.log(`[runs] next run of task ${taskId.slice(0, 8)}: ${(err as Error).message}`)
      }
    }
  }

  const syncOnce = async () => {
    const now = deps.now()
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
      await syncRuns(space, brain, now)
      await syncNextRuns(space, brain, now)
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
