import { createServer } from 'http'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import { timingSafeEqual } from 'crypto'
import { z } from 'zod'
import { readJobMessages } from '../application/read-job-messages'
import { replyToMessage } from '../application/reply-to-message'
import { approveOutboxDraft } from '../application/approve-outbox-draft'
import { skipOutboxDraft } from '../application/skip-outbox-draft'
import type { RequestSendDeps } from '../application/request-send'
import type { ApproveDraftDeps } from '../application/approve-outbox-draft'

export type BridgeApiDeps = RequestSendDeps & ApproveDraftDeps

export type Log = (event: string, fields: Record<string, string | number | boolean>) => void

export interface BridgeApiOptions {
  /** Held by the job tools' MCP processes. */
  toolToken: string
  /** Held by the cockpit only: approving and skipping drafts. A job session never has it. */
  cockpitToken: string
  log: Log
}

const MAX_BODY_BYTES = 1_000_000
const replyBodySchema = z.object({ text: z.string().min(1).max(100_000) })

type Result = { kind: string; reason?: string; retryable?: boolean }

/**
 * The bridge's loopback API, versioned /v1. Job tools read and reply for their job; the cockpit
 * approves and skips drafts. Each side has its own token, and without both the API refuses to start.
 */
export function createBridgeApi(deps: BridgeApiDeps, options: BridgeApiOptions): Server {
  if (!options.toolToken || !options.cockpitToken || options.toolToken === options.cockpitToken) {
    throw new Error('the bridge API needs a tool token and a different cockpit token')
  }

  return createServer((req, res) => {
    handle(deps, options, req, res).catch(() => {
      options.log('api.error', { method: req.method ?? '' })
      send(res, 500, { kind: 'failed', reason: 'internal', retryable: true })
    })
  })
}

async function handle(deps: BridgeApiDeps, options: BridgeApiOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  if (req.method !== 'POST') return send(res, 404, { kind: 'refused', reason: 'unknown_route', retryable: false })

  const read = path.match(/^\/v1\/jobs\/([^/]+)\/messages\/read$/)
  const reply = path.match(/^\/v1\/jobs\/([^/]+)\/messages\/([^/]+)\/reply$/)
  const decide = path.match(/^\/v1\/outbox\/([^/]+)\/(approve|skip)$/)

  if (read?.[1] || reply?.[1]) {
    if (!authorized(req, options.toolToken)) return send(res, 401, { kind: 'refused', reason: 'unauthorized', retryable: false })
  } else if (decide?.[1]) {
    if (!authorized(req, options.cockpitToken)) return send(res, 401, { kind: 'refused', reason: 'unauthorized', retryable: false })
  } else {
    return send(res, 404, { kind: 'refused', reason: 'unknown_route', retryable: false })
  }

  const body = await readBody(req)
  if (body === null) return send(res, 400, { kind: 'refused', reason: 'invalid_request', retryable: false })

  if (read?.[1]) {
    const jobId = decodeURIComponent(read[1])
    const result = await readJobMessages(deps, { jobId })
    options.log('job.read', { jobId, outcome: result.kind, count: result.kind === 'messages' ? result.messages.length : 0 })
    return send(res, statusOf(result), result)
  }

  if (reply?.[1] && reply[2]) {
    const parsed = replyBodySchema.safeParse(body)
    if (!parsed.success) return send(res, 400, { kind: 'refused', reason: 'invalid_request', retryable: false })
    const jobId = decodeURIComponent(reply[1])
    const result = await replyToMessage(deps, { jobId, messageId: decodeURIComponent(reply[2]), text: parsed.data.text })
    options.log('job.reply', { jobId, outcome: result.kind, length: parsed.data.text.length })
    return send(res, statusOf(result), result)
  }

  if (decide?.[1] && decide[2]) {
    const outboxId = decodeURIComponent(decide[1])
    const result = decide[2] === 'approve' ? await approveOutboxDraft(deps, { outboxId }) : await skipOutboxDraft(deps, { outboxId })
    options.log(`outbox.${decide[2]}`, { outboxId, outcome: result.kind })
    return send(res, statusOf(result), result)
  }
}

/** The status tells the caller whether to try again: 4xx when it cannot help, 5xx when it may. */
function statusOf(result: Result): number {
  if (result.kind === 'refused') {
    if (result.reason?.startsWith('unknown_')) return 404
    if (result.reason === 'not_a_draft') return 409
    return 403
  }
  if (result.kind === 'failed') return result.retryable ? 503 : 502
  return 200
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const wanted = Buffer.from(token)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

/** The parsed JSON body, {} for none, or null for one that is too large or not JSON. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
