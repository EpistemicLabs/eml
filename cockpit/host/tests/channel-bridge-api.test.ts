import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleBridgeApi } from '../src/channel-bridge-api.js'

// The page's way to a job's drafts: four routes through to the bridge, with the cockpit's token
// added here, never handed to the page.
const seen: { method?: string; path?: string; auth?: string; body?: string }[] = []
let bridge: http.Server
let host: http.Server
let bridgeUrl: string | null
let hostUrl: string

beforeAll(async () => {
  bridge = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body })
      res.writeHead(req.url?.includes('missing') ? 404 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ kind: 'drafts', drafts: [] }))
    })
  })
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve))
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`
  host = http.createServer((req, res) => {
    void handleBridgeApi(req, res, { url: () => bridgeUrl, cockpitToken: () => 'cockpit-secret' })
  })
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve))
  hostUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => host.close(() => resolve()))
  await new Promise<void>((resolve) => bridge.close(() => resolve()))
})

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${hostUrl}${path}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, text: await response.text() }
}

describe('handleBridgeApi', () => {
  it('passes a job\'s drafts through with the cockpit token and keeps the token out of the answer', async () => {
    const answer = await call('GET', '/api/bridge/jobs/job-1/drafts')
    expect(answer.status).toBe(200)
    expect(seen.at(-1)).toMatchObject({ method: 'GET', path: '/v1/jobs/job-1/drafts', auth: 'Bearer cockpit-secret' })
    expect(answer.text).not.toContain('cockpit-secret')
  })

  it('passes approve, skip and edit through with their body', async () => {
    for (const action of ['approve', 'skip']) {
      expect((await call('POST', `/api/bridge/outbox/o-1/${action}`)).status).toBe(200)
      expect(seen.at(-1)).toMatchObject({ method: 'POST', path: `/v1/outbox/o-1/${action}` })
    }
    await call('POST', '/api/bridge/outbox/o-1/edit', { text: 'Changed' })
    expect(seen.at(-1)).toMatchObject({ path: '/v1/outbox/o-1/edit', body: JSON.stringify({ text: 'Changed' }) })
  })

  it('passes the bridge\'s status on', async () => {
    expect((await call('GET', '/api/bridge/jobs/missing/drafts')).status).toBe(404)
  })

  it('refuses any other route without asking the bridge', async () => {
    const before = seen.length
    for (const [method, path] of [['GET', '/api/bridge/jobs/job-1/messages/read'], ['POST', '/api/bridge/jobs/job-1/messages/m/reply'], ['GET', '/api/bridge/outbox/o-1/approve'], ['GET', '/api/bridge/jobs/a%2F..%2Fx/drafts']] as const) {
      expect((await call(method, path)).status).toBe(404)
    }
    expect(seen.length).toBe(before)
  })

  it('says the bridge is off when it does not run', async () => {
    const saved = bridgeUrl
    bridgeUrl = null
    expect(await call('GET', '/api/bridge/jobs/job-1/drafts')).toMatchObject({ status: 503 })
    bridgeUrl = saved
  })
})
