import type * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { JOB_TOKENS_DIR } from './paths.js'
import { CHANNELS, routeOf, type WakeOutcome } from './domain/job-contract.js'
import type { Job, ReplyChannel } from './domain/job.js'
import type { JobStore } from './job-store.js'

/**
 * The /v1 routes the channel bridge calls (domain/job-contract.ts). A space's
 * token sits in <home>/job-tokens/<brain id>, made once and kept: the bridge
 * reads it there. A token reaches its own space's jobs and nothing else.
 */

export interface JobContractDeps {
  store: JobStore
  /** The brain ids of the spaces; the first is the main space, whose jobs carry no space id. */
  spaceIds(): string[]
  wake(job: Job, channel: ReplyChannel, text: string, key: string): Promise<WakeOutcome>
  tokensDir?: string
}

type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>

const TOKEN_FILE = /^[0-9a-zA-Z-]+$/
const MAX_TEXT = 2000

/**
 * The spaces the bridge may reach, main first: the local ones. A shared space, or one the host
 * could not ask about, gets no token, so no mail of this cockpit's accounts reaches a brain other
 * people read.
 */
export function jobSpaceIdsOf(spaces: ReadonlyArray<{ id: string; main: boolean; shared: boolean | null }>): string[] {
  const main = spaces.find((space) => space.main)
  return [...(main ? [main.id] : []), ...spaces.filter((space) => !space.main && space.shared === false).map((space) => space.id)]
}

/** Make a token for every space that has none. Existing ones stay as they are. */
export function ensureJobTokens(spaceIds: string[], dir = JOB_TOKENS_DIR): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  for (const id of spaceIds) {
    if (!TOKEN_FILE.test(id)) continue
    const file = path.join(dir, id)
    if (fs.existsSync(file)) continue
    fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
  }
}

/** The space a bearer token belongs to, or null. */
function spaceOfToken(header: string | undefined, spaceIds: string[], dir: string): string | null {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null
  const given = Buffer.from(token)
  for (const id of spaceIds) {
    let stored: Buffer
    try { stored = Buffer.from(fs.readFileSync(path.join(dir, id), 'utf8').trim()) } catch { continue }
    if (stored.length === given.length && timingSafeEqual(stored, given)) return id
  }
  return null
}

const isChannel = (value: unknown): value is ReplyChannel => typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)

export async function handleJobContract(
  req: http.IncomingMessage, res: http.ServerResponse, deps: JobContractDeps, json: Json, readJson: ReadJson,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (!url.pathname.startsWith('/v1/')) return false
  const method = req.method ?? 'GET'
  const spaceIds = deps.spaceIds()
  const space = spaceOfToken(req.headers.authorization, spaceIds, deps.tokensDir ?? JOB_TOKENS_DIR)
  if (!space) {
    json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'A space token is required' } })
    return true
  }
  const mainId = spaceIds[0]
  const spaceOf = (job: Job) => job.spaceId ?? mainId

  if (url.pathname === '/v1/jobs' && method === 'GET') {
    const channel = url.searchParams.get('channel')
    if (url.searchParams.get('space') !== space) {
      json(res, 403, { error: { code: 'WRONG_SPACE', message: 'This token is for another space' } })
      return true
    }
    if (!isChannel(channel)) {
      json(res, 400, { error: { code: 'INVALID_CHANNEL', message: `channel must be one of ${CHANNELS.join(', ')}` } })
      return true
    }
    const routes = deps.store.list().filter((job) => spaceOf(job) === space).flatMap((job) => routeOf(job, space, channel) ?? [])
    json(res, 200, routes)
    return true
  }

  const wake = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})\/wake$/)
  if (wake && method === 'POST') {
    const body = await readJson(req)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : ''
    if (!text || text.length > MAX_TEXT || !key || key.length > 200) {
      json(res, 400, { error: { code: 'INVALID_WAKE', message: `text (at most ${MAX_TEXT} characters) and idempotencyKey are required` } })
      return true
    }
    const job = deps.store.get(wake[1])
    // Another space's job is answered like no job at all.
    if (!job || spaceOf(job) !== space) {
      json(res, 200, { outcome: 'refused' })
      return true
    }
    const channel = isChannel(body.channel) ? body.channel : job.triggers.map((t) => t.type).find(isChannel)
    if (!channel) {
      json(res, 200, { outcome: 'refused' })
      return true
    }
    json(res, 200, { outcome: await deps.wake(job, channel, text, key) })
    return true
  }

  json(res, 404, { error: { code: 'NOT_FOUND', message: 'No such endpoint' } })
  return true
}
