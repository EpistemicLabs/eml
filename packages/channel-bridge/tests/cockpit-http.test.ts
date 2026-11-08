import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'http'
import type { Server, IncomingMessage, ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { CockpitHttpClient } from '../src/adapters/cockpit-http/cockpit-http-client'
import { MemoryJobDirectory } from '../src/adapters/memory/memory-job-directory'
import { contractRoutes, jobDirectoryContract } from './contracts/job-directory-contract'

// A stand-in cockpit that speaks the /v1 job contract: routes per space behind that space's
// token, and a wake answer chosen per job.
interface StandIn {
  routes: Record<string, unknown[]>
  tokens: Record<string, string>
  wakeAnswers: Record<string, { status: number; body?: unknown }>
  wakes: { jobId: string; auth: string | undefined; body: unknown }[]
}

function handler(standIn: StandIn) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const auth = req.headers.authorization
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      if (req.method === 'GET' && url.pathname === '/v1/jobs') {
        const space = url.searchParams.get('space') ?? ''
        if (auth !== `Bearer ${standIn.tokens[space]}`) return reply(res, 401, { reason: 'unauthorized', retryable: false })
        return reply(res, 200, standIn.routes[space] ?? [])
      }
      const wake = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/wake$/)
      if (req.method === 'POST' && wake?.[1]) {
        standIn.wakes.push({ jobId: wake[1], auth, body: JSON.parse(raw) })
        const answer = standIn.wakeAnswers[wake[1]] ?? { status: 404, body: { reason: 'unknown_job', retryable: false } }
        return reply(res, answer.status, answer.body ?? {})
      }
      reply(res, 404, {})
    })
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const tokens = { support: 'token-support', errands: 'token-errands' }
const spaces = Object.entries(tokens).map(([space, token]) => ({ space, token }))

const main: StandIn = {
  routes: {
    support: [
      { jobId: 'job-1', space: 'support', matches: [{ kind: 'domain', domain: 'customer.example' }], reply: { mail: 'draft' }, extra: 'ignored' },
    ],
    errands: [{ jobId: 'job-2', space: 'errands', matches: [], reply: {} }],
  },
  tokens,
  wakeAnswers: {
    'job-1': { status: 200, body: { outcome: 'delivered' } },
    'job-busy': { status: 200, body: { outcome: 'retry' } },
    'job-ended': { status: 200, body: { outcome: 'refused' } },
    'job-broken': { status: 500 },
    'job-garbled': { status: 200, body: { outcome: 'maybe' } },
    'job-bad-request': { status: 400, body: { reason: 'invalid_request', retryable: false } },
    'job-throttled': { status: 429 },
  },
  wakes: [],
}
const contract: StandIn = {
  routes: {
    support: contractRoutes.filter((route) => route.space === 'support'),
    errands: contractRoutes.filter((route) => route.space === 'errands'),
  },
  tokens,
  wakeAnswers: {},
  wakes: [],
}

const servers: Server[] = []
const urls: Record<'main' | 'contract', string> = { main: '', contract: '' }
beforeAll(async () => {
  for (const [name, standIn] of [['main', main], ['contract', contract]] as const) {
    const server = createServer(handler(standIn))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    urls[name] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
})
afterAll(() => Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))))

const client = (url = urls.main) => new CockpitHttpClient({ url, spaces })
const unreachable = 'http://127.0.0.1:1'

jobDirectoryContract('memory', () => new MemoryJobDirectory(contractRoutes))
jobDirectoryContract('cockpit http', () => client(urls.contract))

describe('CockpitHttpClient as job directory', () => {
  it('reads a space\'s mail routes with that space\'s token and drops unknown fields', async () => {
    expect(await client().routesInSpace('support')).toEqual([
      { jobId: 'job-1', space: 'support', matches: [{ kind: 'domain', domain: 'customer.example' }], reply: { mail: 'draft' } },
    ])
  })

  it('refuses a space it has no token for', async () => {
    await expect(client().routesInSpace('elsewhere')).rejects.toThrow('no token')
  })

  it('fails loudly when the cockpit cannot be reached, so a sync keeps its cursor', async () => {
    await expect(client(unreachable).routesInSpace('support')).rejects.toThrow()
  })
})

describe('CockpitHttpClient as cockpit', () => {
  const wake = (jobId: string, space = 'support', url = urls.main) =>
    client(url).wakeJob({ jobId, space, text: '2 new messages', idempotencyKey: `${jobId}:7` })

  it('sends the wake with the space\'s token and returns the cockpit\'s outcome', async () => {
    expect(await wake('job-1')).toBe('delivered')
    expect(main.wakes.at(-1)).toEqual({
      jobId: 'job-1', auth: 'Bearer token-support', body: { text: '2 new messages', idempotencyKey: 'job-1:7' },
    })
    expect(await wake('job-busy')).toBe('retry')
    expect(await wake('job-ended')).toBe('refused')
  })

  it('treats a server error, an answer it cannot read and an unreachable cockpit as retry', async () => {
    expect(await wake('job-broken')).toBe('retry')
    expect(await wake('job-garbled')).toBe('retry')
    expect(await wake('job-1', 'support', unreachable)).toBe('retry')
  })

  it('treats an unknown job and a request the cockpit cannot take as refused, throttling as retry', async () => {
    expect(await wake('job-unknown')).toBe('refused')
    expect(await wake('job-bad-request')).toBe('refused')
    expect(await wake('job-throttled')).toBe('retry')
  })

  it('refuses a wake for a space it has no token for: retrying cannot help', async () => {
    expect(await wake('job-1', 'elsewhere')).toBe('refused')
  })
})
