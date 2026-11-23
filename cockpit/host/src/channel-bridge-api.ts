import type * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CHANNEL_BRIDGE_HOME } from './paths.js'

/**
 * The page's way to a job's drafts in the channel bridge: four routes, passed through with the
 * cockpit's token, which never leaves the host. Like every /api write, a change needs the page's
 * own origin (http.ts); a job's session never has this token, so it cannot approve its own drafts.
 */

export interface BridgeApiDeps {
  /** Where the bridge listens now, or null when it does not run. */
  url(): string | null
  cockpitToken(): string | null
}

const ID = '[A-Za-z0-9_-]+'
const ROUTES: { method: string; pattern: RegExp; to: (id: string, action?: string) => string }[] = [
  { method: 'GET', pattern: new RegExp(`^/api/bridge/jobs/(${ID})/drafts$`), to: (id) => `/v1/jobs/${id}/drafts` },
  { method: 'POST', pattern: new RegExp(`^/api/bridge/outbox/(${ID})/(approve|skip|edit)$`), to: (id, action) => `/v1/outbox/${id}/${action}` },
]
const MAX_BODY = 200_000

export async function handleBridgeApi(req: http.IncomingMessage, res: http.ServerResponse, deps: BridgeApiDeps): Promise<void> {
  const pathname = (req.url ?? '').split('?')[0] ?? ''
  const route = ROUTES.find((entry) => entry.method === req.method && entry.pattern.test(pathname))
  const match = route ? pathname.match(route.pattern) : null
  if (!route || !match?.[1]) return send(res, 404, { kind: 'refused', reason: 'unknown_route', retryable: false })
  const url = deps.url()
  const token = deps.cockpitToken()
  if (!url || !token) return send(res, 503, { kind: 'unavailable', reason: 'bridge_off', retryable: true })

  let body: string | undefined
  if (req.method === 'POST') {
    const read = await readBody(req)
    if (read === null) return send(res, 413, { kind: 'refused', reason: 'too_large', retryable: false })
    body = read
  }
  try {
    const upstream = await fetch(`${url}${route.to(match[1], match[2])}`, {
      method: route.method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(30_000),
    })
    res.writeHead(upstream.status, { 'content-type': 'application/json' })
    res.end(await upstream.text())
  } catch {
    send(res, 503, { kind: 'unavailable', reason: 'bridge_unreachable', retryable: true })
  }
}

/** The bridge's address and the cockpit's token, as the bridge wrote them into its folder. */
export function bridgeFiles(home = CHANNEL_BRIDGE_HOME): BridgeApiDeps {
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(home, name), 'utf8').trim() || null
    } catch {
      return null
    }
  }
  return { url: () => read('url'), cockpitToken: () => read('cockpit-token') }
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}
