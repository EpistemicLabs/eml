import type * as http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpHttpEndpoint } from '@engramprotocol/mcp-server'
import type { MessageRequest } from './application/deliver-message.js'
import { recordEndTurn, type RecordEndTurnDeps, type SaidTurn } from './application/record-end-turn.js'
import { endTurn, listSessions, schedule, sendMessage, type ToolAnswer } from './application/session-tools.js'
import { header, mcpStatus, refuse, sessionCaller } from './brain-mcp.js'
import type { BrainSpaces } from './brain-space.js'
import type { AgentProvider } from './domain/agent-provider.js'
import type { DeliveryOutcome } from './domain/session-delivery.js'
import type { DirectoryEntry } from './domain/session-directory.js'
import { SESSION_TOOLS } from './domain/session-tools.js'
import { COCKPIT_MCP_SERVER, MCP_SESSION_HEADER, MCP_TOKEN_HEADER } from './infrastructure/providers/shared.js'
import type { SessionLedger } from './session-ledger.js'

/**
 * The cockpit MCP endpoint: the cockpit's own session tools (domain/session-tools.ts:
 * end_turn, schedule, send_message, list_sessions) over Streamable HTTP
 * (/mcp/cockpit), for a session whose agent CLI gets them from an MCP server:
 * one that runs in a terminal, and a chat session of the same providers
 * (Codex through its app-server, providers/codex/chat-runtime.ts). Claude
 * Code's chat sessions have them in their own process
 * (providers/claude/sdk-runtime.ts), under the same server name, cockpit.
 * A chat session also gets offer_split and propose_sort here: the chat
 * renders their calls as cards, a terminal has nothing to show them with.
 *
 * Who may call is what the brain endpoint asks (brain-mcp.ts sessionCaller):
 * this machine only, the space's MCP token, a session the ledger knows in that
 * space. The space needs no agent bound: no brain is reached from here. On top,
 * the session has to be one the endpoint serves (`served`, notServed): a
 * session of a provider whose sessions get the tools here.
 *
 * Every tool acts as the calling session and no other: the MCP session is
 * bound to it on initialize (McpHttpEndpoint), and no tool takes a session to
 * act for.
 *
 * end_turn only keeps the call and brings the task's wake-up in line with its check. A
 * chat session's is kept where the chat keeps what a session said
 * (chat-bridge.ts said). A session in the terminal fallback has no turn
 * routing: its call is not kept.
 */

export const COCKPIT_MCP_PATH = '/mcp/cockpit'

export { COCKPIT_MCP_SERVER }

/** Why a chat session is refused, and what it does instead. */
export const CHAT_HAS_ITS_OWN = 'The cockpit MCP endpoint serves sessions that run in a terminal. This session runs in chat and has the cockpit\'s tools built in: call those instead.'

/**
 * Why the endpoint does not serve a session, or null. A session is served when its provider's sessions get the
 * tools here (capability terminalTools): in a terminal, and in the chat, where such a provider's agent CLI has
 * no other way to them. Another provider's terminal session is refused with that provider's reason, its chat
 * session because it has the tools built in.
 */
export function notServed(session: { runtime: string } | undefined, provider: Pick<AgentProvider, 'capabilities'>): string | null {
  const { terminalTools } = provider.capabilities
  if (session?.runtime === 'terminal') return terminalTools.supported ? null : terminalTools.reason
  return session?.runtime === 'sdk' && terminalTools.supported ? null : CHAT_HAS_ITS_OWN
}

export interface CockpitMcpDeps {
  spaces: Pick<BrainSpaces, 'byMcpToken'>
  ledger: Pick<SessionLedger, 'get'>
  /**
   * Why the endpoint does not serve this session, in words that say what to do; null: it does.
   * Absent: every session that runs in a terminal is served, a chat session is not.
   */
  served?: (sessionId: string) => string | null
  /** What a chat session said, where the chat keeps it (chat-bridge.ts said); absent: no chat session is served. */
  chatTurns?: { said(sessionId: string, turn: SaidTurn): unknown }
  /** Whom a call is read against, when it is read and what its check does to the task's wake-up: as a chat session's (chat-bridge.ts). */
  turnOf: RecordEndTurnDeps['turnOf']
  callTime?: RecordEndTurnDeps['callTime']
  turnWake?: RecordEndTurnDeps['turnWake']
  /** The schedule tool's actions for the session that calls it (application/jobs.ts); absent: no tool. */
  jobs?: (sessionId: string, input: Record<string, unknown>) => Promise<string>
  /** The sessions the caller may message, without itself (http.ts directoryEntries). */
  directory(sessionId: string): DirectoryEntry[]
  /** The caller's own address, as the receiver of its message reads it. */
  addressOf(sessionId: string): string | null
  /** The one way to reach a session (application/deliver-message.ts). */
  deliver(request: MessageRequest): Promise<DeliveryOutcome>
  /**
   * Whether a message sent back would reach the caller (domain/agent-provider.ts sessionMessaging): a Codex session in
   * the chat, as a Claude Code one there. Absent: a session in the chat does, one in a terminal does not.
   */
  receives?: (sessionId: string) => boolean
  /** The user's time zone as a session is told it (domain/schedule.ts zoneLabel). */
  timeZone?: () => string
  serverVersion?: string
}

export function createCockpitMcpHandler(deps: CockpitMcpDeps) {
  const served = deps.served ?? ((sessionId: string) => (deps.ledger.get(sessionId)?.runtime === 'terminal' ? null : CHAT_HAS_ITS_OWN))

  const answered = ({ text, isError }: ToolAnswer) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) })

  /** Where the session runs now: it can move between the two while its agent CLI keeps the MCP session. */
  const inChat = (sessionId: string) => deps.ledger.get(sessionId)?.runtime === 'sdk'

  /** The tools for one session. Each handler closes over `sessionId`: the caller the MCP session is bound to. */
  const serverFor = (sessionId: string): McpServer => {
    const server = new McpServer({ name: COCKPIT_MCP_SERVER, version: deps.serverVersion ?? '0.0.0' })
    const T = SESSION_TOOLS
    const zone = deps.timeZone?.()
    const recording: RecordEndTurnDeps = {
      turnOf: deps.turnOf,
      ...(deps.callTime ? { callTime: deps.callTime } : {}),
      keep: (id, said) => { if (inChat(id)) deps.chatTurns?.said(id, said) },
      ...(deps.turnWake ? { turnWake: deps.turnWake } : {}),
    }
    server.registerTool(T.endTurn.name, { description: T.endTurn.description(zone), inputSchema: T.endTurn.input },
      async (input) => answered(await endTurn({ endTurn: (call) => recordEndTurn(recording, sessionId, call) }, input)))
    const jobs = deps.jobs
    if (jobs) {
      server.registerTool(T.schedule.name, { description: T.schedule.description(zone), inputSchema: T.schedule.input },
        async (input) => answered(await schedule({ jobs: (asked) => jobs(sessionId, asked) }, input)))
    }
    server.registerTool(T.sendMessage.name, { description: T.sendMessage.description(), inputSchema: T.sendMessage.input },
      async (input) => answered(await sendMessage({
        directory: () => deps.directory(sessionId),
        from: deps.addressOf(sessionId),
        // A sender a message sent back would not reach, such as one in a terminal (deliver-message.ts).
        noReply: !(deps.receives ? deps.receives(sessionId) : inChat(sessionId)),
        deliver: deps.deliver,
      }, input)))
    server.registerTool(T.listSessions.name, { description: T.listSessions.description(), inputSchema: T.listSessions.input },
      async (input) => answered(listSessions({ directory: () => deps.directory(sessionId) }, input)))
    if (inChat(sessionId)) {
      // Change nothing: the chat renders the call as a card, and the user's choice comes back as a message.
      server.registerTool(T.offerSplit.name, { description: T.offerSplit.description(), inputSchema: T.offerSplit.input },
        async () => answered({ text: T.offerSplit.answer, isError: false }))
      server.registerTool(T.proposeSort.name, { description: T.proposeSort.description(), inputSchema: T.proposeSort.input },
        async () => answered({ text: T.proposeSort.answer, isError: false }))
    }
    return server
  }

  const endpoint = new McpHttpEndpoint({ createServer: ({ sessionId }) => serverFor(sessionId) })

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const who = sessionCaller(deps, req, header(req, MCP_TOKEN_HEADER), header(req, MCP_SESSION_HEADER), 'The cockpit MCP endpoint')
    if ('refused' in who) return refuse(res, mcpStatus(req, who), who.refused)
    const sessionId = who.sessionId as string
    // On every request: a session that moved to the chat view keeps no way in through an MCP session it opened before.
    const notServed = served(sessionId)
    if (notServed) return refuse(res, mcpStatus(req, { refused: notServed, status: 403 }), notServed)
    try {
      await endpoint.handle(req, res, { owner: who.space.id, sessionId })
    } catch (err) {
      if (!res.headersSent) refuse(res, 500, (err as Error).message)
    }
  }

  return { handle, close: (sessionId?: string) => endpoint.close(sessionId) }
}
