import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handlePushApi } from '../src/push-api.js'
import { PushStore } from '../src/push-store.js'

// The page's side of web push: the server key, this device's subscription, a test, and what the user is looking at.
const store = new PushStore(join(mkdtempSync(join(tmpdir(), 'push-api-')), 'push.json'), () => ({ publicKey: 'server-public', privateKey: 'server-private' }))
const watched: string[][] = []
const present: (string | null)[] = []
const tested: string[] = []
let host: http.Server
let url: string

const json = (res: http.ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}
const readJson = (req: http.IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => resolve(body ? JSON.parse(body) as Record<string, unknown> : {}))
})

beforeAll(async () => {
  host = http.createServer((req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
    void handlePushApi(req, res, {
      store,
      notifier: {
        watching: (ids) => { watched.push(ids) },
        present: (endpoint) => { present.push(endpoint) },
        test: async (endpoint) => { tested.push(endpoint); return endpoint.endsWith('/gone') ? 'gone' : endpoint.endsWith('/unknown') ? 'unknown' : endpoint.endsWith('/down') ? 'failed' : endpoint.endsWith('/refused') ? 'refused' : 'sent' },
      },
    }, parsed, req.method ?? 'GET', json, readJson).then((handled) => { if (!handled) json(res, 404, {}) })
  })
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(host.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise<void>((resolve) => host.close(() => resolve())) })

async function call(method: string, path: string, body?: unknown, origin = 'https://cockpit.example') {
  const response = await fetch(`${url}${path}`, {
    method, headers: { 'content-type': 'application/json', origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

const subscription = { endpoint: 'https://push.example/phone', keys: { p256dh: 'p256dh-key', auth: 'auth-secret' }, label: 'iPhone' }

describe('handlePushApi', () => {
  it('hands out the server\'s public key and says whether this device is subscribed', async () => {
    expect(await call('GET', '/api/push?endpoint=https%3A%2F%2Fpush.example%2Fphone')).toEqual({ status: 200, body: { publicKey: 'server-public', subscribed: false } })
    expect(JSON.stringify(await call('GET', '/api/push'))).not.toContain('server-private')
  })

  it('keeps a device with the address it subscribed on, and lets it go again', async () => {
    expect((await call('PUT', '/api/push/subscription', subscription)).status).toBe(200)
    expect(store.devices()).toMatchObject([{ endpoint: subscription.endpoint, origin: 'https://cockpit.example', label: 'iPhone' }])
    expect((await call('GET', '/api/push?endpoint=https%3A%2F%2Fpush.example%2Fphone')).body.subscribed).toBe(true)
    expect(await call('DELETE', '/api/push/subscription', { endpoint: subscription.endpoint })).toEqual({ status: 200, body: { removed: true } })
    expect(store.devices()).toEqual([])
  })

  it('refuses a subscription it cannot use, with a reason to branch on', async () => {
    expect(await call('PUT', '/api/push/subscription', { ...subscription, endpoint: 'http://push.example/plain' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_SUBSCRIPTION', retry: false } } })
    expect(await call('PUT', '/api/push/subscription', { endpoint: subscription.endpoint })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_SUBSCRIPTION' } } })
    expect(await call('PUT', '/api/push/subscription', subscription, '')).toMatchObject({ status: 400, body: { error: { code: 'NO_ORIGIN', retry: false } } })
  })

  it('sends a test to the asking device and says when its subscription is gone', async () => {
    expect(await call('POST', '/api/push/test', { endpoint: 'https://push.example/phone' })).toEqual({ status: 200, body: { outcome: 'sent' } })
    expect(await call('POST', '/api/push/test', { endpoint: 'https://push.example/gone' })).toMatchObject({ status: 410, body: { error: { code: 'GONE' } } })
    expect(tested).toEqual(['https://push.example/phone', 'https://push.example/gone'])
  })

  it('says when the device is unknown and when the push service may take it on a retry', async () => {
    expect(await call('POST', '/api/push/test', { endpoint: 'https://push.example/unknown' })).toMatchObject({ status: 404, body: { error: { code: 'UNKNOWN_DEVICE', retry: false } } })
    expect(await call('POST', '/api/push/test', {})).toMatchObject({ status: 404, body: { error: { code: 'UNKNOWN_DEVICE' } } })
    expect(await call('POST', '/api/push/test', { endpoint: 'https://push.example/down' })).toMatchObject({ status: 502, body: { error: { code: 'PUSH_FAILED', retry: true } } })
    expect(await call('POST', '/api/push/test', { endpoint: 'https://push.example/refused' })).toMatchObject({ status: 502, body: { error: { code: 'PUSH_REJECTED', retry: false } } })
  })

  it('takes the sessions the user is looking at and the device they work on', async () => {
    expect((await call('POST', '/api/push/watching', { sessionIds: ['s1', 42, 's2'], endpoint: 'https://push.example/mac' })).status).toBe(200)
    expect(watched.at(-1)).toEqual(['s1', 's2'])
    expect(present.at(-1)).toBe('https://push.example/mac')
    await call('POST', '/api/push/watching', { sessionIds: [] })
    expect(present.at(-1)).toBeNull()
  })
})

describe('handlePushApi with a store it cannot write', () => {
  it('hands out no key and keeps no device, and says a retry may help', async () => {
    const unwritable = { vapid: () => null, devices: () => [], subscribe: () => null, unsubscribe: () => false }
    const server = http.createServer((req, res) => {
      void handlePushApi(req, res, { store: unwritable, notifier: { watching: () => {}, present: () => {}, test: async () => 'sent' as const } },
        new URL(req.url ?? '/', 'http://127.0.0.1'), req.method ?? 'GET', json, readJson)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const key = await fetch(`${base}/api/push`)
      expect(key.status).toBe(503)
      expect(await key.json()).toMatchObject({ error: { code: 'STORE_UNWRITABLE', retry: true } })
      const put = await fetch(`${base}/api/push/subscription`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'https://cockpit.example' }, body: JSON.stringify(subscription) })
      expect(put.status).toBe(503)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
