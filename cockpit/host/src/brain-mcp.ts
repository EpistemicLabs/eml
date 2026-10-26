import type * as http from 'node:http'
import { HttpClient, McpHttpEndpoint, Provenance } from '@engramprotocol/mcp-server'
import type { BrainSpaces } from './brain-space.js'
import type { SessionLedger } from './session-ledger.js'
import type { ProviderRegistry } from './infrastructure/providers/registry.js'
import { MCP_SESSION_HEADER, MCP_TOKEN_HEADER } from './infrastructure/providers/shared.js'
import { isLocalRequest } from './remote-access.js'

/**
 * The brain MCP endpoint: one Streamable HTTP endpoint (/mcp) in the host
 * instead of one stdio adapter process per session
 * (docs/proposals/brain-mcp-over-http.md). Claude Code sessions reach their
 * brain through it; Codex keeps the stdio adapter until its HTTP MCP support
 * is checked.
 *
 * Who may call, checked on every request:
 *   - only this machine: a proxied or non-loopback request is refused, whatever
 *     remote access allows (remote-access.ts isLocalRequest);
 *   - the space's MCP token (MCP_TOKEN_HEADER) picks the space; the URL names
 *     none, so there is nothing to swap for another brain;
 *   - the session (MCP_SESSION_HEADER, from the session's COCKPIT_SESSION_ID)
 *     must be in the ledger and belong to that space.
 * The MCP session is bound to that space and session on initialize
 * (McpHttpEndpoint), and its writes carry them as provenance; the model comes
 * from the ledger. The brain token never leaves the host.
 */

export const MCP_PATH = '/mcp'

export interface BrainMcpDeps {
  spaces: BrainSpaces
  ledger: SessionLedger
  providers: ProviderRegistry
  serverVersion?: string
}

/** The model a cockpit session runs with, from its transcript (null when unknown). */
export function sessionModel(deps: BrainMcpDeps, sessionId: string): string | null {
  const entry = deps.ledger.get(sessionId)
  if (!entry) return null
  const project = entry.projectId ? deps.spaces.resolve(entry.spaceId).registry.get(entry.projectId) : undefined
  return deps.providers.forSession(sessionId).summary(deps.ledger.ref(sessionId, project?.path ?? null)).model ?? null
}

const header = (req: http.IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

export function createBrainMcpHandler(deps: BrainMcpDeps) {
  const endpoint = new McpHttpEndpoint({
    clientName: 'eml-cockpit',
    serverVersion: deps.serverVersion,
    open: ({ owner, sessionId }) => {
      const space = deps.spaces.get(owner)
      if (!space) throw new Error(`space ${owner} is gone`)
      const provenance = Provenance.forSession(sessionId, async () => sessionModel(deps, sessionId))
      const client = new HttpClient({ url: space.url, token: space.token, writeHeaders: () => provenance.headers() })
      return { client, provenance }
    },
  })

  const refuse = (res: http.ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32003, message }, id: null }))
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!isLocalRequest(req)) return refuse(res, 403, 'The brain MCP endpoint is local only')
    const space = deps.spaces.byMcpToken(header(req, MCP_TOKEN_HEADER))
    if (!space) return refuse(res, 403, 'Bad MCP token')
    const sessionId = header(req, MCP_SESSION_HEADER)
    const entry = sessionId ? deps.ledger.get(sessionId) : undefined
    if (!sessionId || !entry) return refuse(res, 403, 'Unknown session')
    if ((entry.spaceId ?? null) !== space.ledgerKey) return refuse(res, 403, 'The session belongs to another space')
    try {
      await endpoint.handle(req, res, { owner: space.id, sessionId })
    } catch (err) {
      if (!res.headersSent) refuse(res, 500, (err as Error).message)
    }
  }

  return { handle, close: (sessionId?: string) => endpoint.close(sessionId) }
}
