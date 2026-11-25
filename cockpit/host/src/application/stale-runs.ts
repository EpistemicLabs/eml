import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace, BrainSpaces } from '../brain-space.js'
import type { ProviderRegistry } from '../infrastructure/providers/registry.js'
import { runsOf } from '../domain/runs.js'
import { hungSessions, isStaleWait, staleWaitsAfter, STALE_WHY, type OwnSession } from '../domain/stale-runs.js'
import { sameWaits, waitsBody, waitsOf } from '../domain/task-waits.js'
import type { SessionLedger } from '../session-ledger.js'
import { trackWaits } from './task-waits.js'

/**
 * Hung workers (domain/stale-runs.ts): on each tick, this cockpit's sessions whose run says running
 * without activity for STALE_MS get their stopped wait on the task's owner, and a session that
 * shows activity again, ended its turn or was put away loses it.
 *
 * The wait is written once per silence: a session whose wait this host wrote is remembered, so an
 * answer that cleared the wait while the session stays silent does not bring it back. The memory is
 * rebuilt from the open tasks at the first tick after a start, so a wait left by a host that
 * stopped is still removed once its run ended.
 */

/** The open tasks read once per space to find stale waits (the board's limit). */
const OPEN_LIMIT = 500

export interface StaleSession extends Omit<OwnSession, 'activityAt'> {
  /** The space it runs in, resolved (null in the ledger is the main space). */
  spaceId: string
}

export interface StaleRunsDeps {
  spaces(): BrainSpace[]
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /** This cockpit's member: only their runs are judged, and a task without an owner waits on them. */
  me: string
  sessions(): StaleSession[]
  /** When this cockpit last saw the session do something (ISO time), asked only for a run that looks silent. */
  activityAt?(sessionId: string): string | null
  log(line: string): void
  now?: () => Date
}

export interface StaleRuns {
  /** Look at this cockpit's runs once; one at a time. Never throws. */
  tick(): Promise<void>
  /** Ticks every `ms`; returns the stop. */
  every(ms: number): () => void
}

/** When the session's conversation last changed on disk, as its provider reads it; null when it has none. */
export function sessionActivity(deps: { ledger: Pick<SessionLedger, 'get' | 'ref'>; spaces: Pick<BrainSpaces, 'resolve'>; providers: Pick<ProviderRegistry, 'forSession'> }, sessionId: string): string | null {
  const entry = deps.ledger.get(sessionId)
  if (!entry) return null
  const space = deps.spaces.resolve(entry.spaceId)
  const project = entry.projectId ? space.registry.get(entry.projectId) : undefined
  const summary = deps.providers.forSession(sessionId).summary(deps.ledger.ref(sessionId, project?.path ?? null, space.runtime))
  return summary.lastActivity ?? summary.lastMessageAt ?? null
}

export function createStaleRuns(deps: StaleRunsDeps): StaleRuns {
  const now = () => deps.now?.() ?? new Date()
  /** Sessions that hold a stale wait this host wrote or found, with their space and task. */
  const told = new Map<string, { spaceId: string; taskId: string }>()
  /** Spaces whose open tasks were read for stale waits after the host started. */
  const adopted = new Set<string>()
  /** Spaces whose runs could not be read, logged once (a brain from before schema 23). */
  const unreadable = new Set<string>()
  let running: Promise<void> | null = null

  /** The stale waits of this cockpit's sessions that are in the brain already. */
  const adopt = async (space: BrainSpace, brain: Pick<EmlApi, 'get'>, sessions: StaleSession[]) => {
    const own = new Set(sessions.map((s) => s.sessionId))
    for (const status of ['planned', 'active']) {
      const listed = await brain.get('/list', { type: 'task', status, limit: OPEN_LIMIT }) as { engrams?: Array<{ id: string; properties?: { waits?: unknown; waiting_on?: unknown } }> }
      for (const task of listed.engrams ?? []) {
        for (const w of waitsOf(task.properties)) if (isStaleWait(w) && own.has(w.id)) told.set(w.id, { spaceId: space.id, taskId: task.id })
      }
    }
    adopted.add(space.id)
  }

  /** Brings one session's stale wait in line; true when the task now holds it. */
  const settle = async (brain: Pick<EmlApi, 'get' | 'post'>, taskId: string, sessionId: string, hung: boolean) => {
    let holds = false
    const { patch } = await trackWaits(brain, taskId, (task) => {
      const waits = waitsOf(task.properties)
      const after = staleWaitsAfter({ task, sessionId, hung, me: deps.me, now: now() })
      holds = (after ?? waits).some((w) => w.id === sessionId && isStaleWait(w))
      return after && !sameWaits(after, waits) ? waitsBody(after) : null
    })
    if (patch) deps.log(`[stale] ${sessionId.slice(0, 8)} task=${taskId.slice(0, 8)} ${hung ? `waits on its owner: ${STALE_WHY}` : 'is active again or ended: wait cleared'}`)
    return holds
  }

  const tickOnce = async () => {
    const all = deps.sessions()
    for (const space of deps.spaces()) {
      const brain = deps.brain(space)
      if (!brain) continue
      const sessions = all.filter((s) => s.spaceId === space.id)
      let hung: Map<string, string>
      try {
        const runs = runsOf(((await brain.get('/object/run')) as { objects?: Array<Record<string, unknown>> }).objects ?? [])
        if (!adopted.has(space.id)) await adopt(space, brain, sessions)
        // The run's own stamp first; only for one that looks silent, what this cockpit sees of the session.
        const silent = hungSessions({ runs, sessions, me: deps.me, now: now().getTime() })
        const seen = sessions.map((s) => (silent.has(s.sessionId) ? { ...s, activityAt: deps.activityAt?.(s.sessionId) ?? null } : s))
        hung = hungSessions({ runs, sessions: seen, me: deps.me, now: now().getTime() })
      } catch (err) {
        if (!unreadable.has(space.id)) deps.log(`[stale] ${space.name}: runs not readable — ${(err as Error).message}`)
        unreadable.add(space.id)
        continue
      }
      for (const [sessionId, taskId] of hung) {
        if (told.has(sessionId)) continue
        try {
          if (await settle(brain, taskId, sessionId, true)) told.set(sessionId, { spaceId: space.id, taskId })
        } catch (err) {
          deps.log(`[stale] ${sessionId.slice(0, 8)} failed: ${(err as Error).message}`)
        }
      }
      for (const [sessionId, at] of told) {
        if (at.spaceId !== space.id || hung.has(sessionId)) continue
        try {
          await settle(brain, at.taskId, sessionId, false)
          told.delete(sessionId)
        } catch (err) {
          deps.log(`[stale] ${sessionId.slice(0, 8)} failed: ${(err as Error).message}`)
        }
      }
    }
  }

  const stale: StaleRuns = {
    async tick() {
      while (running) await running
      running = tickOnce().catch((err: Error) => deps.log(`[stale] tick failed: ${err.message}`)).finally(() => { running = null })
      return running
    },
    every(ms) {
      const timer = setInterval(() => { void stale.tick() }, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }
  return stale
}
