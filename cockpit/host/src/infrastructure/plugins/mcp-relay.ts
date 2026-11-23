import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Connection } from '../../domain/space-plugins.js'
import { oauthValuesOf, type McpOAuth, type OAuthValues } from './mcp-oauth.js'
import type { SharedMcpHost } from './shared-mcp.js'

/** Where a space's sessions reach a signed-in server: <cockpit>/mcp-relay/<connection id>. */
export const RELAY_PATH = '/mcp-relay'
export const RELAY_KEY_HEADER = 'x-eml-relay-key'

/** Request headers the server sees from the session; everything else stays here (cookies, hosts, the key). */
const FORWARDED = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
const RETURNED = ['content-type', 'mcp-session-id', 'cache-control']
const EARLY_MS = 60_000

type Renewal = OAuthValues | 'refused' | 'unreachable'

export interface RelayDeps {
  connections(): Promise<Connection[]>
  /** Writes a connection's new values without rewriting the spaces' session files. */
  update(id: string, change: (connection: Connection) => Connection): Promise<void>
  /** The server a plugin's mcp part names (its URL), or null when it has none. */
  serverUrl(pluginId: string): Promise<string | null>
  oauth: Pick<McpOAuth, 'refresh'>
  isLocal(req: IncomingMessage): boolean
  /** The servers the cockpit runs once for every session (a stdio part with `shared`). */
  shared?: Pick<SharedMcpHost, 'keyFor' | 'isShared' | 'endpoint' | 'discard'>
  log?: (line: string) => void
}

/**
 * The relay between a space's sessions and an MCP server they share: a remote server the user signed
 * in to here, or a server the cockpit runs once for all sessions (shared-mcp.ts). For a remote one it
 * adds a current access token to every request and renews it before it runs out, so a running session
 * never sees an expired sign-in; a refused renewal marks the sign-in for "Sign in again". A shared one
 * it starts when needed and passes its key. Only sessions on this machine reach it, with the
 * connection's own key (it is in their MCP config).
 */
export class McpRelay {
  /** One renewal per connection at a time; requests in between wait for it. */
  private readonly renewing = new Map<string, Promise<Renewal>>()

  constructor(private readonly deps: RelayDeps) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = /^\/mcp-relay\/([a-z0-9][a-z0-9-]{0,62})(?:\?.*)?$/.exec(req.url ?? '')?.[1]
    const refuse = (status: number, message: string) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', message } }))
    }
    if (!id || !this.deps.isLocal(req)) return refuse(403, 'The relay serves sessions on this machine only')
    const connection = (await this.deps.connections()).find((c) => c.id === id)
    const shared = connection && this.deps.shared && (await this.deps.shared.isShared(connection)) ? this.deps.shared : null
    const given = Buffer.from(String(req.headers[RELAY_KEY_HEADER] ?? ''))
    const key = Buffer.from(connection ? (shared ? shared.keyFor(connection.id) : (connection.values.relayKey ?? '')) : '')
    if (!connection || key.length === 0 || given.length !== key.length || !timingSafeEqual(given, key)) return refuse(403, 'Unknown sign-in or wrong key')
    if (shared) return this.handleShared(req, res, connection, shared, refuse)
    const upstream = await this.deps.serverUrl(connection.plugin)
    let values = oauthValuesOf(connection.values)
    if (!upstream || !values) return refuse(404, 'This sign-in names no server it can reach')

    const body = await readBody(req)
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    if (values.expiresAt && Number(values.expiresAt) - EARLY_MS < Date.now()) {
      const early = await this.renew(connection.id, values)
      if (typeof early === 'object') values = early
    }
    let response = await this.forward(req, upstream, values.accessToken, body, controller.signal).catch(() => null)
    if (response?.status === 401) {
      // Revoked or expired earlier than it said: renew once and try again.
      await response.body?.cancel().catch(() => undefined)
      const renewed = await this.renew(connection.id, values)
      if (renewed === 'refused') return refuse(401, `The sign-in "${connection.label}" has run out: sign in again in Settings › Plugins`)
      response = renewed === 'unreachable' ? null : await this.forward(req, upstream, renewed.accessToken, body, controller.signal).catch(() => null)
    }
    if (!response) {
      if (!res.headersSent) refuse(502, 'The server cannot be reached right now')
      return
    }
    pipeResponse(response, res)
  }

  /** A shared server: started when it isn't running, and once more when it ended in between. */
  private async handleShared(
    req: IncomingMessage,
    res: ServerResponse,
    connection: Connection,
    shared: NonNullable<RelayDeps['shared']>,
    refuse: (status: number, message: string) => void,
  ): Promise<void> {
    const body = await readBody(req)
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    const attempt = async () => {
      const endpoint = await shared.endpoint(connection)
      if (!endpoint) throw new Error('the sign-in has no shared server')
      return this.forward(req, endpoint.url, endpoint.token, body, controller.signal)
    }
    // A server that does not answer is replaced once; a call it got never reaches the new one (its
    // session id is unknown there), so nothing runs twice.
    const response = await attempt().catch(() => {
      if (controller.signal.aborted) throw new Error('the session went away')
      shared.discard(connection.id)
      return attempt()
    }).catch((err: Error) => {
      this.deps.log?.(`[plugins] the shared server of ${connection.id} cannot be reached: ${err.message}`)
      return null
    })
    if (!response) {
      if (!res.headersSent) refuse(502, 'The server cannot be reached right now')
      return
    }
    pipeResponse(response, res)
  }

  private forward(req: IncomingMessage, upstream: string, token: string, body: Buffer | null, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    for (const name of FORWARDED) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const query = (req.url ?? '').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?')) : ''
    return fetch(`${upstream}${query}`, { method: req.method ?? 'GET', headers, body: body && body.length > 0 ? new Uint8Array(body) : undefined, signal })
  }

  /** New tokens, kept in the connection; `refused` marks the sign-in for signing in again. */
  private renew(id: string, values: OAuthValues): Promise<Renewal> {
    const running = this.renewing.get(id)
    if (running) return running
    const work = (async () => {
      const answer = await this.deps.oauth.refresh(values)
      if (answer.kind === 'unreachable') return 'unreachable' as const
      if (answer.kind === 'refused') {
        this.deps.log?.(`[plugins] the sign-in ${id} was refused on renewal: it needs signing in again`)
        await this.deps.update(id, (c) => ({ ...c, signInNeeded: true }))
        return 'refused' as const
      }
      await this.deps.update(id, (c) => ({ ...c, signInNeeded: false, values: { ...c.values, ...stringValues(answer.values) } }))
      return answer.values
    })()
    this.renewing.set(id, work)
    return work.finally(() => this.renewing.delete(id))
  }
}

/** OAuth values as a connection stores them: strings, nothing undefined. */
export function stringValues(values: OAuthValues): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/** The server's answer to the session: its status, the headers it may see, the body streamed. */
function pipeResponse(response: Response, res: ServerResponse): void {
  const headers: Record<string, string> = {}
  for (const name of RETURNED) {
    const value = response.headers.get(name)
    if (value) headers[name] = value
  }
  res.writeHead(response.status, headers)
  if (!response.body) return void res.end()
  Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).on('error', () => res.destroy()).pipe(res)
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return null
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
