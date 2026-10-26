import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createEmlMcpServer } from './factory'
import type { HttpClient } from './http-client'
import type { Provenance } from './provenance'

/**
 * One Streamable HTTP endpoint serving the EML tools to many agent sessions,
 * instead of one stdio process per session (docs/proposals/brain-mcp-over-http.md).
 *
 * The embedding server authenticates every request and says who is calling
 * (McpHttpCaller): which brain the caller may reach (`owner`) and which agent
 * session it is (`sessionId`), both checked by the embedder. An MCP session
 * is created on `initialize` for that caller and bound to it: a later request
 * on the same mcp-session-id from another caller is refused, so neither the
 * brain nor the provenance can change mid-session.
 */

export interface McpHttpCaller {
  /** The brain the caller may reach (the cockpit: the space its token belongs to). */
  owner: string
  /** The agent session, already checked by the embedder; it goes into every write. */
  sessionId: string
}

export interface McpHttpEndpointOptions {
  /** The EML API client and provenance for a new MCP session of `caller`. */
  open(caller: McpHttpCaller): { client: HttpClient; provenance: Provenance }
  clientName?: string
  serverVersion?: string
}

interface Session {
  caller: McpHttpCaller
  server: McpServer
  transport: StreamableHTTPServerTransport
}

/** Requests above this size are refused; a tool call is a few kilobytes. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

export class McpHttpEndpoint {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly opts: McpHttpEndpointOptions) {}

  /** Open MCP sessions (tests, diagnostics). */
  get size(): number {
    return this.sessions.size
  }

  async handle(req: IncomingMessage, res: ServerResponse, caller: McpHttpCaller): Promise<void> {
    let body: unknown
    if (req.method === 'POST') {
      const parsed = await readJsonBody(req)
      if (!parsed.ok) return rpcError(res, parsed.status, -32700, parsed.message)
      body = parsed.value
    }

    const header = req.headers['mcp-session-id']
    const mcpSessionId = Array.isArray(header) ? header[0] : header
    if (mcpSessionId) {
      const session = this.sessions.get(mcpSessionId)
      // 404 tells the client to start a new MCP session (spec: session management).
      if (!session) return rpcError(res, 404, -32001, 'Session not found')
      if (session.caller.owner !== caller.owner || session.caller.sessionId !== caller.sessionId) {
        return rpcError(res, 403, -32003, 'This MCP session belongs to another caller')
      }
      await session.transport.handleRequest(req, res, body)
      return
    }

    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      return rpcError(res, 400, -32000, 'No MCP session: send initialize first')
    }
    const { client, provenance } = this.opts.open(caller)
    const server = createEmlMcpServer({
      client, provenance, clientName: this.opts.clientName, serverVersion: this.opts.serverVersion,
    })
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { this.sessions.set(id, { caller, server, transport }) },
    })
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId)
    }
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  /** Close the MCP sessions of one agent session (it ended), or of every session. */
  async close(sessionId?: string): Promise<void> {
    const closing = [...this.sessions.values()].filter((s) => sessionId === undefined || s.caller.sessionId === sessionId)
    await Promise.all(closing.map((s) => s.transport.close().catch(() => undefined)))
  }
}

type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; message: string }

function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve({ ok: false, status: 413, message: 'Request too large' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        resolve({ ok: false, status: 400, message: 'Parse error: the body is not JSON' })
      }
    })
    req.on('error', () => resolve({ ok: false, status: 400, message: 'Request body could not be read' }))
  })
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}
