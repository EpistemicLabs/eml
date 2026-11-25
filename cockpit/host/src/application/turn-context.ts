import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace, BrainSpaces } from '../brain-space.js'
import type { TurnContext } from '../domain/turn-end.js'
import type { SessionLedger } from '../session-ledger.js'

/**
 * Whom an end_turn call is read against (domain/turn-end.ts TurnContext): the
 * owner is this cockpit's member, the agent is the one the session's space
 * binds, and the handles are the space's users and agents as its brain lists
 * them. With it, the session's task: its name, whether it is open, its
 * checkpoint.
 *
 * The handles are read once per space and kept for HANDLES_MS: a member who
 * joined since reads as someone outside until then.
 */

/** What a space's agent goes by while none is bound: one of the words that always name the session itself. */
export const NO_AGENT = 'agent'
const HANDLES_MS = 5 * 60_000

export interface SessionTurn {
  ctx: TurnContext
  /** The session's task as its brain has it now; null without one, or when it cannot be read. */
  task: { id: string; name: string; open: boolean } | null
}

export interface TurnContextDeps {
  ledger: Pick<SessionLedger, 'get'>
  spaces: Pick<BrainSpaces, 'resolve'>
  brain(space: BrainSpace): Pick<EmlApi, 'get'> | null
  /** This cockpit's member (config handle). */
  owner: string
  now?: () => number
}

export interface TurnContexts {
  /** The handles of the space's users and agents; empty when its brain does not answer. */
  handles(space: BrainSpace): Promise<readonly string[]>
  of(sessionId: string): Promise<SessionTurn>
}

interface Task {
  id: string
  status: string
  title?: string
  properties?: { display_title?: string; checkpoint?: string }
}

export function createTurnContexts(deps: TurnContextDeps): TurnContexts {
  const now = () => deps.now?.() ?? Date.now()
  const known = new Map<string, { handles: string[]; at: number }>()

  const handles = async (space: BrainSpace): Promise<readonly string[]> => {
    const seen = known.get(space.id)
    if (seen && now() - seen.at < HANDLES_MS) return seen.handles
    const brain = deps.brain(space)
    if (!brain) return seen?.handles ?? []
    try {
      const listed = await Promise.all(['user', 'agent'].map((object) => brain.get(`/object/${object}`) as Promise<{ objects?: Array<{ id?: unknown }> }>))
      const found = [...new Set(listed.flatMap((l) => l.objects ?? []).map((o) => o.id).filter((id): id is string => typeof id === 'string' && id !== ''))]
      known.set(space.id, { handles: found, at: now() })
      return found
    } catch {
      // The last list is better than none: without it every handle reads as outside.
      return seen?.handles ?? []
    }
  }

  return {
    handles,
    async of(sessionId) {
      const entry = deps.ledger.get(sessionId)
      const space = deps.spaces.resolve(entry?.spaceId ?? null)
      const ctx: TurnContext = { owner: deps.owner, agent: space.agent ?? NO_AGENT, members: await handles(space) }
      const brain = entry?.taskId ? deps.brain(space) : null
      if (!brain) return { ctx, task: null }
      const task = await brain.get(`/engram/${encodeURIComponent(entry!.taskId!)}`).catch(() => null) as Task | null
      if (!task?.id) return { ctx, task: null }
      const checkpoint = task.properties?.checkpoint
      return {
        ctx: { ...ctx, ...(checkpoint ? { checkpoint } : {}) },
        task: { id: task.id, name: task.properties?.display_title ?? task.title ?? task.id, open: task.status === 'planned' || task.status === 'active' },
      }
    },
  }
}
