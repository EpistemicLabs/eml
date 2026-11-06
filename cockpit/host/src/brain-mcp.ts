import type * as http from 'node:http'
import { EmlApiError, HttpClient, McpHttpEndpoint, Provenance, RoutedClient, type EmlApi } from '@engramprotocol/mcp-server'
import type { AgentBrain, AgentBrains } from './agents.js'
import type { BrainSpace, BrainSpaces } from './brain-space.js'
import type { SessionLedger } from './session-ledger.js'
import type { ProviderRegistry } from './infrastructure/providers/registry.js'
import { MCP_SESSION_HEADER, MCP_TOKEN_HEADER } from './infrastructure/providers/shared.js'
import { isLocalRequest } from './remote-access.js'

/**
 * The brain MCP endpoint: one Streamable HTTP endpoint (/mcp) in the host
 * instead of one stdio adapter process per session. Every agent session —
 * Claude Code and Codex — reaches its brains through it.
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
 * from the ledger. No brain token leaves the host.
 *
 * A session runs as the agent its space binds (agents.ts; decision
 * cockpit-identity-agent-brain): its identity engrams go to the agent brain
 * and its work to the space (mcp-server routed-client.ts), and every write to
 * either brain is stamped with the agent (x-eml-agent). A space without a
 * bound agent gets no brain: the endpoint and the hook routes refuse, and
 * say why.
 *
 * The session hooks (boot, project block, note edits) use the same view of
 * the brains through the hook routes (HOOKS_PATH): the EML API as the session
 * sees it, read-only, with the space's MCP token as the bearer — so the hook
 * config of a space names the host, not a brain.
 */

export const MCP_PATH = '/mcp'
export const HOOKS_PATH = '/hooks'

/** The read routes of the EML API the session hooks call (mcp-server hooks/). */
const HOOK_ROUTES: ReadonlyArray<[method: string, path: string]> = [['POST', '/boot'], ['POST', '/project-block'], ['GET', '/list']]

export interface BrainMcpDeps {
  spaces: BrainSpaces
  agents: AgentBrains
  ledger: SessionLedger
  providers: ProviderRegistry
  serverVersion?: string
}

/** The model a cockpit session runs with, from its transcript (null when unknown). */
export function sessionModel(deps: Pick<BrainMcpDeps, 'spaces' | 'ledger' | 'providers'>, sessionId: string): string | null {
  const entry = deps.ledger.get(sessionId)
  if (!entry) return null
  const space = deps.spaces.resolve(entry.spaceId)
  const project = entry.projectId ? space.registry.get(entry.projectId) : undefined
  return deps.providers.forSession(sessionId).summary(deps.ledger.ref(sessionId, project?.path ?? null, space.runtime)).model ?? null
}

const header = (req: http.IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** Why a space's sessions get no brain: no agent bound, and the agent upgrade's reason when it left it so. */
export const noAgentMessage = (space: Pick<BrainSpace, 'name' | 'upgrade'>) =>
  `Space "${space.name}" has no agent bound — its sessions get no brain until an agent is bound to it.${space.upgrade ? ` Agent upgrade: ${space.upgrade.reason}` : ''}`

/** A refusal and the HTTP status it answers with: 403 for who may not call, 503 for a space that has no brain to offer. */
export interface Refusal {
  refused: string
  status: 403 | 503
}

/** The agent brain a space's sessions run as; a refusal naming the reason when there is none. */
export function boundAgent(deps: Pick<BrainMcpDeps, 'agents'>, space: BrainSpace): AgentBrain | Refusal {
  if (!space.agent) return { refused: noAgentMessage(space), status: 503 }
  const agent = deps.agents.get(space.agent)
  if (!agent) return { refused: `Space "${space.name}" binds agent "${space.agent}", whose brain this cockpit does not have — its sessions get no brain until that is fixed.`, status: 503 }
  return agent
}

/**
 * The EML API as a session of `space` sees it: the space's brain and the
 * bound agent's, routed by scope. Every write stamps the agent; `provenance`
 * (the session, its model and harness) comes with it on the MCP endpoint and
 * is absent on the read-only hook routes.
 */
export function sessionClient(space: BrainSpace, agent: AgentBrain, provenance?: Provenance): EmlApi {
  const writeHeaders = async () => ({ ...(provenance ? await provenance.headers() : {}), 'x-eml-agent': agent.id })
  return new RoutedClient({
    space: new HttpClient({ url: space.url, token: space.token, writeHeaders }),
    agent: new HttpClient({ url: agent.url, token: agent.token, writeHeaders }),
    agentId: agent.id,
    spaceBrainId: space.id,
  })
}

type Caller = { space: BrainSpace; agent: AgentBrain; sessionId: string | null } | Refusal

/**
 * Who calls on behalf of a session: from this machine, with a space's MCP
 * token, and — on the MCP endpoint — as a session the ledger knows in that
 * space. The hook routes carry the token as the bearer and name no session:
 * they read only, and the per-boot token is the space's own.
 */
function caller(deps: Pick<BrainMcpDeps, 'spaces' | 'agents' | 'ledger'>, req: http.IncomingMessage, mcpToken: string | undefined, sessionId: string | undefined | null): Caller {
  if (!isLocalRequest(req)) return { refused: 'The brain MCP endpoint is local only', status: 403 }
  const space = deps.spaces.byMcpToken(mcpToken)
  if (!space) return { refused: 'Bad MCP token', status: 403 }
  if (sessionId !== null) {
    const entry = sessionId ? deps.ledger.get(sessionId) : undefined
    if (!sessionId || !entry) return { refused: 'Unknown session', status: 403 }
    if ((entry.spaceId ?? null) !== space.ledgerKey) return { refused: 'The session belongs to another space', status: 403 }
  }
  const agent = boundAgent(deps, space)
  if ('refused' in agent) return agent
  return { space, agent, sessionId: sessionId ?? null }
}

const refuse = (res: http.ServerResponse, status: number, message: string) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32003, message }, id: null }))
}

const json = (res: http.ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** Requests above this size are refused; a hook sends a budget or a scope. */
const MAX_HOOK_BODY = 64 * 1024

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_HOOK_BODY) return null
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function createBrainMcpHandler(deps: BrainMcpDeps) {
  const endpoint = new McpHttpEndpoint({
    clientName: 'eml-cockpit',
    serverVersion: deps.serverVersion,
    open: ({ owner, sessionId }) => {
      const space = deps.spaces.get(owner)
      if (!space) throw new Error(`space ${owner} is gone`)
      const agent = boundAgent(deps, space)
      if ('refused' in agent) throw new Error(agent.refused)
      const provenance = Provenance.forSession(sessionId, async () => sessionModel(deps, sessionId))
      return { client: sessionClient(space, agent, provenance), provenance }
    },
  })

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const who = caller(deps, req, header(req, MCP_TOKEN_HEADER), header(req, MCP_SESSION_HEADER))
    if ('refused' in who) return refuse(res, who.status, who.refused)
    try {
      await endpoint.handle(req, res, { owner: who.space.id, sessionId: who.sessionId as string })
    } catch (err) {
      if (!res.headersSent) refuse(res, 500, (err as Error).message)
    }
  }

  /**
   * The hook routes: <HOOKS_PATH><EML API path>, the space's MCP token as the
   * bearer. The reads the session hooks make go through the session's routed
   * client, so a hook sees the brains as the session's tools do.
   */
  const handleHooks = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.slice(HOOKS_PATH.length)
    const method = req.method ?? 'GET'
    if (!HOOK_ROUTES.some(([m, p]) => m === method && p === path)) return json(res, 404, { error: 'No such hook route' })
    const bearer = header(req, 'authorization')?.replace(/^Bearer /, '')
    const who = caller(deps, req, bearer, null)
    // A space without an agent is not a bad token (403): the hook then names the reason, not a revoked token.
    if ('refused' in who) return json(res, who.status, { error: who.refused })
    const client = sessionClient(who.space, who.agent)
    try {
      if (method === 'GET') {
        const query: Record<string, string> = {}
        for (const [k, v] of url.searchParams) query[k] = v
        return json(res, 200, await client.get(path, query))
      }
      const body = await readJson(req)
      if (!body) return json(res, 400, { error: 'The body is not a JSON object' })
      return json(res, 200, await client.post(path, body))
    } catch (err) {
      if (res.headersSent) return
      if (err instanceof EmlApiError) return json(res, err.status || 502, err.body ?? { error: err.message })
      return json(res, 502, { error: (err as Error).message })
    }
  }

  return { handle, handleHooks, close: (sessionId?: string) => endpoint.close(sessionId) }
}
