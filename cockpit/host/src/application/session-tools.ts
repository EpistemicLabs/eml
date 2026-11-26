import { searchResult, searchSessions, SEARCH_LIMIT, type DirectoryEntry, type DirectoryQuery } from '../domain/session-directory.js'
import type { DeliveryOutcome } from '../domain/session-delivery.js'
import type { EndTurnRecorded } from '../domain/session-runtime.js'
import { LIST_SESSIONS_MAX, LIST_SESSIONS_WORDING, notReachable, scheduleFailed, SEND_MESSAGE_INCOMPLETE, sendMessageAnswer, sendMessageFailed, wasDelivered } from '../domain/session-tools.js'
import { endTurnAnswer, notRecorded, readEndTurn, type EndTurn } from '../domain/turn-end.js'
import type { MessageRequest } from './deliver-message.js'

/**
 * What the cockpit's own session tools do (domain/session-tools.ts has their
 * names, descriptions and shapes), against ports: the same handler answers a
 * chat session's in-process tool and a terminal session's call over MCP, each
 * with its own way to record a call, reach the jobs or hand a message on.
 *
 * Every handler answers with the text the agent reads. `isError`: the tool
 * did not do what was asked, and the agent should not read it as done.
 */

export interface ToolAnswer {
  text: string
  isError: boolean
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error')

export interface EndTurnPorts {
  /** Records the call and says what its answer has to name. Rejects with the reason when nothing was recorded. */
  endTurn(call: EndTurn): Promise<EndTurnRecorded>
}

/**
 * Why a call was refused, or what was recorded and what it still lacks. An error means nothing was recorded:
 * the chat then shows a failed tool row and not the end of the turn (frontend turn-end-line.ts turnEndOfTool).
 */
export async function endTurn(ports: EndTurnPorts, input: unknown): Promise<ToolAnswer> {
  const read = readEndTurn(input)
  if (!read.ok) return { text: read.error, isError: true }
  try {
    const { derived, missing, checkProblem, checkFix, checkTime, nextRun } = await ports.endTurn(read.call)
    return { text: endTurnAnswer(read.call, derived, { missing, checkProblem, checkFix, checkTime, nextRun }), isError: false }
  } catch (error: unknown) {
    return { text: notRecorded(reasonOf(error)), isError: true }
  }
}

export interface SchedulePorts {
  /** The schedule tool's actions for this session (application/jobs.ts); the answer is what the agent reads. */
  jobs(input: Record<string, unknown>): Promise<string>
}

/** The jobs' own answer. Their refusals are answers too, so only the text says when the tool itself failed. */
export async function schedule(ports: SchedulePorts, input: Record<string, unknown>): Promise<ToolAnswer> {
  const text = await ports.jobs(input).catch((error: unknown) => scheduleFailed(reasonOf(error)))
  return { text, isError: false }
}

export interface SendMessagePorts {
  /** The sessions the caller may message (stopped and archived ones too), without itself. */
  directory(): DirectoryEntry[]
  /** The caller's own address, so the receiver reads who wrote; null: it is not said. */
  from: string | null
  /** The caller cannot be messaged back (it runs in a terminal): the receiver is told so instead of how to reply. */
  noReply?: boolean
  /** The one way to reach a session (application/deliver-message.ts). */
  deliver(request: MessageRequest): Promise<DeliveryOutcome>
}

/**
 * Hands another session a message, a stopped one after resuming it. Only a session of the caller's own
 * directory is asked for: any other address reads as one that cannot be messaged, whether it exists or not.
 */
export async function sendMessage(ports: SendMessagePorts, input: { to?: unknown; text?: unknown }): Promise<ToolAnswer> {
  const to = typeof input.to === 'string' ? input.to.trim() : ''
  const text = typeof input.text === 'string' ? input.text : ''
  if (!to || !text.trim()) return { text: SEND_MESSAGE_INCOMPLETE, isError: true }
  if (!ports.directory().some((entry) => entry.address === to)) return { text: notReachable(to), isError: true }
  try {
    const outcome = await ports.deliver({ target: to, text, from: ports.from, caller: 'session', ...(ports.noReply ? { noReply: true } : {}) })
    return { text: sendMessageAnswer(outcome, to), isError: !wasDelivered(outcome) }
  } catch (error: unknown) {
    return { text: sendMessageFailed(to, reasonOf(error)), isError: true }
  }
}

export interface ListSessionsPorts {
  /** The sessions the caller may message, as the search command reads them (GET /api/session-directory). */
  directory(): DirectoryEntry[]
}

/**
 * A search as it is asked for, read into the query: the one place its bounds are. The tool's input,
 * and GET /api/session-directory's parameters (http.ts directoryAnswer).
 */
export function directoryQueryOf(input: { words?: unknown; state?: unknown; project?: unknown; archived?: unknown; limit?: unknown }): DirectoryQuery {
  const words = Array.isArray(input.words) ? input.words.join(' ') : typeof input.words === 'string' ? input.words : ''
  const limit = Number(input.limit)
  return {
    words: words.split(/\s+/).filter(Boolean),
    ...(input.state === 'running' || input.state === 'stopped' ? { state: input.state } : {}),
    ...(typeof input.project === 'string' && input.project.trim() ? { project: input.project } : {}),
    archived: input.archived === true,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, LIST_SESSIONS_MAX) : SEARCH_LIMIT,
  }
}

/**
 * The sessions that fit, as the search command prints them (domain/session-directory.ts searchResult);
 * where that names the command and ListAgents, the tool's answer names the tool.
 */
export function listSessions(ports: ListSessionsPorts, input: Parameters<typeof directoryQueryOf>[0]): ToolAnswer {
  const query = directoryQueryOf(input)
  return { text: searchResult(searchSessions(ports.directory(), query), query, LIST_SESSIONS_WORDING), isError: false }
}
