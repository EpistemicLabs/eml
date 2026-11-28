import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace, BrainSpaces } from '../brain-space.js'
import type { AgentProvider } from '../domain/agent-provider.js'
import type { EndTurnAccess, TurnContext } from '../domain/turn-end.js'
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
const NO_AGENT = 'agent'
const HANDLES_MS = 5 * 60_000

/**
 * Whether a session can call end_turn: its provider's sessions have the tool
 * (domain/agent-provider.ts, capability endTurnTool), and it runs in the chat,
 * or in a terminal of a provider whose terminal sessions get the cockpit's
 * tools (capability terminalTools).
 */
export function hasEndTurnTool(session: { runtime: string } | undefined, provider: Pick<AgentProvider, 'capabilities'>): boolean {
  const { endTurnTool, terminalTools } = provider.capabilities
  return endTurnTool.supported && (session?.runtime === 'sdk' || (session?.runtime === 'terminal' && terminalTools.supported))
}

/**
 * How a session has end_turn, for the texts that tell it (domain/turn-end.ts): a session of a provider whose
 * sessions get the cockpit's tools from the host's endpoint (capability terminalTools) gets it from the MCP server
 * of this name, which may not have connected, in a terminal and in the chat alike; another provider's chat
 * session has it built in.
 */
export function endTurnAccess(session: { runtime: string } | undefined, provider: Pick<AgentProvider, 'capabilities'>, mcpServer: string): EndTurnAccess {
  if (!hasEndTurnTool(session, provider)) return false
  return provider.capabilities.terminalTools.supported ? { mcpServer } : true
}

/**
 * The one place a call's context is put together: the tool's answer, the wait
 * the router writes and the check all read a call against what this returns.
 * `agent`: the space's; none bound goes by NO_AGENT.
 */
export function turnContextOf(who: { owner: string; agent?: string | null; members?: readonly string[]; checkpoint?: string | null }): TurnContext {
  return { owner: who.owner, agent: who.agent || NO_AGENT, members: who.members ?? [], ...(who.checkpoint ? { checkpoint: who.checkpoint } : {}) }
}

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
  /** The task's open steps and whether each is covered, from the task board (TaskBoard.stepsOf); null for none. */
  stepsOf?: (taskId: string) => { open: number; covered: boolean } | null
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
      const who = { owner: deps.owner, agent: space.agent, members: await handles(space) }
      const brain = entry?.taskId ? deps.brain(space) : null
      if (!brain) return { ctx: turnContextOf(who), task: null }
      const task = await brain.get(`/engram/${encodeURIComponent(entry!.taskId!)}`).catch(() => null) as Task | null
      if (!task?.id) return { ctx: turnContextOf(who), task: null }
      const steps = deps.stepsOf?.(task.id) ?? null
      return {
        ctx: { ...turnContextOf({ ...who, checkpoint: task.properties?.checkpoint }), ...(steps ? { steps } : {}) },
        task: { id: task.id, name: task.properties?.display_title ?? task.title ?? task.id, open: task.status === 'planned' || task.status === 'active' },
      }
    },
  }
}
