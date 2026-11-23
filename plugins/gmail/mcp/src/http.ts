import { randomUUID, timingSafeEqual } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

/** The line a shared server writes to stdout once it listens; the cockpit reads its port from it. */
export const LISTENING_PREFIX = 'EML_MCP_LISTENING '

const SWEEP_MS = 10 * 60_000

export interface SharedHttpOptions {
  /** The bearer key every request must carry (the cockpit sets it; nothing else on the machine knows it). */
  key: string
  /** A fresh MCP server for each session that connects; they may share one Google sign-in. */
  newServer: () => McpServer
  /** A session not heard from this long is closed; its client starts a new one. */
  idleMs?: number
  port?: number
}

export interface SharedHttpServer {
  port: number
  sessions(): number
  close(): Promise<void>
}

/**
 * The server as the cockpit runs it once for every session of the machine (a shared MCP part):
 * Streamable HTTP on the loopback address, one MCP session per Claude session, every request with
 * the cockpit's key. The cockpit's relay is the only caller; sessions never see this port or key.
 */
export async function serveShared(options: SharedHttpOptions): Promise<SharedHttpServer> {
  const key = Buffer.from(options.key)
  const idleMs = options.idleMs ?? 24 * 60 * 60_000
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; used: number }>()

  const fail = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))
    if (given.length !== key.length || !timingSafeEqual(given, key)) return fail(res, 401, 'Wrong key')
    const body = req.method === 'POST' ? await readJson(req) : undefined
    if (body === INVALID) return fail(res, 400, 'The body is not JSON')
    const id = req.headers['mcp-session-id']
    if (typeof id === 'string') {
      const session = sessions.get(id)
      if (!session) return fail(res, 404, 'Session not found')
      session.used = Date.now()
      return session.transport.handleRequest(req, res, body)
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) return fail(res, 400, 'No session: initialize first')
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => { sessions.set(sessionId, { transport, used: Date.now() }) },
    })
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId) }
    await options.newServer().connect(transport)
    return transport.handleRequest(req, res, body)
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => { if (!res.headersSent) fail(res, 500, err.message) })
  })
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) if (now - session.used > idleMs) { sessions.delete(id); void session.transport.close() }
  }, Math.min(SWEEP_MS, idleMs))
  sweep.unref()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  return {
    port: (server.address() as AddressInfo).port,
    sessions: () => sessions.size,
    close: async () => {
      clearInterval(sweep)
      await Promise.all([...sessions.values()].map((s) => s.transport.close()))
      sessions.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const INVALID = Symbol('invalid')

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return INVALID
  }
}
