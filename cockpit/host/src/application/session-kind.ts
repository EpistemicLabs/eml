import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace, BrainSpaces } from '../brain-space.js'
import { wasSpawned, worksAlone } from '../domain/session-attention.js'
import type { SessionLedger } from '../session-ledger.js'

/**
 * Whether a session works on its own or is the user's conversation
 * (domain/session-attention.ts worksAlone), by its task as the brain has it
 * now: a hand-over or a take-back since the session started counts at once.
 */
export interface SessionKindDeps {
  ledger: Pick<SessionLedger, 'get'>
  spaces: Pick<BrainSpaces, 'resolve'>
  brain(space: BrainSpace): Pick<EmlApi, 'get'> | null
}

interface Task {
  id?: string
  properties?: { delegate?: string }
}

export function createSessionKind(deps: SessionKindDeps): { worksAlone(sessionId: string): Promise<boolean> } {
  return {
    async worksAlone(sessionId) {
      const entry = deps.ledger.get(sessionId)
      if (!entry) return false
      const brain = entry.taskId ? deps.brain(deps.spaces.resolve(entry.spaceId)) : null
      // A task that cannot be read says nothing: the way the session was started decides.
      const task = brain ? await brain.get(`/engram/${encodeURIComponent(entry.taskId!)}`).catch(() => null) as Task | null : null
      return worksAlone({ delegated: task?.id ? Boolean(task.properties?.delegate) : null, worker: entry.worker, spawned: wasSpawned(entry) })
    },
  }
}
