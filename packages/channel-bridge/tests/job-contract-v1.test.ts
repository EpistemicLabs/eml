import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createServer } from 'http'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { CockpitHttpClient } from '../src/adapters/cockpit-http/cockpit-http-client'

// The cockpit's contract v1 examples, the same file the cockpit tests against
// (cockpit/host/tests/fixtures/job-contract.v1.json). A change to it is a new contract version.
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'job-contract.v1.json'), 'utf8')) as {
  space: string
  routes: { request: { path: string }; response: unknown[] }
  wake: { request: { path: string; body: Record<string, unknown> }; responses: Record<string, unknown> }
}
const token = 'space-token'
let answer: unknown = fixture.wake.responses.delivered
let received: { method?: string; path?: string; auth?: string; body?: Record<string, unknown> } = {}
let server: Server
let client: CockpitHttpClient

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      received = { method: req.method, path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.method === 'GET' ? fixture.routes.response : answer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  client = new CockpitHttpClient({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, spaces: [{ space: fixture.space, token }] })
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe('cockpit job contract v1', () => {
  it('asks for routes the way the contract shows and reads its example answer', async () => {
    const answer = await client.routesInSpace(fixture.space, 'mail')
    expect(received).toMatchObject({ method: 'GET', path: fixture.routes.request.path, auth: `Bearer ${token}` })
    expect(answer).toEqual({ kind: 'routes', routes: fixture.routes.response })
  })

  it('sends a wake the way the contract shows and reads each example outcome', async () => {
    const jobId = fixture.wake.request.path.split('/')[3] ?? ''
    for (const [outcome, body] of Object.entries(fixture.wake.responses)) {
      answer = body
      const result = await client.wakeJob({
        jobId, space: fixture.space,
        text: String(fixture.wake.request.body.text), idempotencyKey: String(fixture.wake.request.body.idempotencyKey),
      })
      expect(result).toBe(outcome)
      expect(received.path).toBe(fixture.wake.request.path)
      expect(Object.keys(received.body ?? {}).every((key) => key in fixture.wake.request.body)).toBe(true)
    }
  })
})
