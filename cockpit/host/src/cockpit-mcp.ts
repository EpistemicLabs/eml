import type * as http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpHttpEndpoint } from '@engramprotocol/mcp-server'
import type { MessageRequest } from './application/deliver-message.js'
import { recordEndTurn, type RecordEndTurnDeps } from './application/record-end-turn.js'
import { endTurn, listSessions, schedule, sendMessage, type ToolAnswer } from './application/session-tools.js'
import type { TerminalTurns } from './application/terminal-turns.js'
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
 * (/mcp/cockpit), for a session that runs in a terminal. A chat session has
 * them in its own process (providers/claude/sdk-runtime.ts); a terminal
 * session's agent CLI reaches them here, under the same server name, cockpit.
 *
 * Who may call is what the brain endpoint asks (brain-mcp.ts sessionCaller):
 * this machine only, the space's MCP token, a session the ledger knows in that
 * space. The space needs no agent bound: no brain is reached from here. On top,
 * the session has to be one the endpoint serves (`served`, notServed): a
 * terminal session of a provider whose terminal sessions get the tools here.
 *
 * Every tool acts as the calling session and no other: the MCP session is
 * bound to it on initialize (McpHttpEndpoint), and no tool takes a session to
 * act for.
 *
 * end_turn only keeps the call (application/terminal-turns.ts) and sets the
 * check its next.when asks for; the session's Stop hook ends the turn with it
 * (terminalTurnEnded). Nothing goes into the ledger at the call: the tools a
 * turn still runs after it would clear it again (application/apply-session-hook.ts).
 */

export const COCKPIT_MCP_PATH = '/mcp/cockpit'

export { COCKPIT_MCP_SERVER }

/** Why a chat session is refused, and what it does instead. */
export const CHAT_HAS_ITS_OWN = 'The cockpit MCP endpoint serves sessions that run in a terminal. This session runs in chat and has the cockpit\'s tools built in: call those instead.'

/**
 * Why the endpoint does not serve a session, or null: one that runs in chat has the tools built in, and a terminal
 * session is served only when its provider's terminal sessions get the tools here (capability terminalTools);
 * another provider's is refused with that provider's reason.
 */
export function notServed(session: { runtime: string } | undefined, provider: Pick<AgentProvider, 'capabilities'>): string | null {
  if (session?.runtime !== 'terminal') return CHAT_HAS_ITS_OWN
  const { terminalTools } = provider.capabilities
  return terminalTools.supported ? null : terminalTools.reason
}

export interface CockpitMcpDeps {
  spaces: Pick<BrainSpaces, 'byMcpToken'>
  ledger: Pick<SessionLedger, 'get'>
  /**
   * Why the endpoint does not serve this session, in words that say what to do; null: it does.
   * Absent: every session that runs in a terminal is served, a chat session is not.
   */
  served?: (sessionId: string) => string | null
  /** What a terminal session said until its Stop hook takes it. */
  terminalTurns: Pick<TerminalTurns, 'said'>
  /** Whom a call is read against, when it is read and the check its next.when sets: as a chat session's (chat-bridge.ts). */
  turnOf: RecordEndTurnDeps['turnOf']
  callTime?: RecordEndTurnDeps['callTime']
  turnCheck?: RecordEndTurnDeps['turnCheck']
  checkSaved?: RecordEndTurnDeps['checkSaved']
  /** The schedule tool's actions for the session that calls it (application/jobs.ts); absent: no tool. */
  jobs?: (sessionId: string, input: Record<string, unknown>) => Promise<string>
  /** The sessions the caller may message, without itself (http.ts directoryEntries). */
  directory(sessionId: string): DirectoryEntry[]
  /** The caller's own address, as the receiver of its message reads it. */
  addressOf(sessionId: string): string | null
  /** The one way to reach a session (application/deliver-message.ts). */
  deliver(request: MessageRequest): Promise<DeliveryOutcome>
  /** The user's time zone as a session is told it (domain/schedule.ts zoneLabel). */
  timeZone?: () => string
  serverVersion?: string
}

export function createCockpitMcpHandler(deps: CockpitMcpDeps) {
  const served = deps.served ?? ((sessionId: string) => (deps.ledger.get(sessionId)?.runtime === 'terminal' ? null : CHAT_HAS_ITS_OWN))

  const answered = ({ text, isError }: ToolAnswer) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) })

  /** The four tools for one session. Each handler closes over `sessionId`: the caller the MCP session is bound to. */
  const serverFor = (sessionId: string): McpServer => {
    const server = new McpServer({ name: COCKPIT_MCP_SERVER, version: deps.serverVersion ?? '0.0.0' })
    const T = SESSION_TOOLS
    const zone = deps.timeZone?.()
    const recording: RecordEndTurnDeps = {
      turnOf: deps.turnOf,
      ...(deps.callTime ? { callTime: deps.callTime } : {}),
      keep: (id, said) => deps.terminalTurns.said(id, said),
      ...(deps.turnCheck ? { turnCheck: deps.turnCheck } : {}),
      ...(deps.checkSaved ? { checkSaved: deps.checkSaved } : {}),
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
        // The sender runs in a terminal: a message sent back would not reach it (deliver-message.ts).
        noReply: true,
        deliver: deps.deliver,
      }, input)))
    server.registerTool(T.listSessions.name, { description: T.listSessions.description(), inputSchema: T.listSessions.input },
      async (input) => answered(listSessions({ directory: () => deps.directory(sessionId) }, input)))
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
