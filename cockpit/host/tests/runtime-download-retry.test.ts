import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NET_RETRY, downloadTo, fetchText } from '../src/infrastructure/providers/managed-runtime.js'

/**
 * fetchText and downloadTo against a local server that fails the first requests of a path
 * the way release CDNs do: 429 (with and without Retry-After), 503, a connection cut off
 * mid-body, a request that never gets an answer. Transient failures are retried; a 404 fails
 * at once.
 */

type Step = (res: ServerResponse) => void
const ok = (body: string): Step => (res) => res.end(body)
const status = (code: number, headers: Record<string, string> = {}): Step => (res) => { res.writeHead(code, headers); res.end() }
const silent: Step = () => {}
const cutOff: Step = (res) => {
  res.writeHead(200, { 'content-length': '1000' })
  res.write('partial')
  setTimeout(() => res.socket?.destroy(), 10)
}

const scripts = new Map<string, Step[]>()
const hits = new Map<string, number>()
let server: Server
let base: string
const root = mkdtempSync(join(tmpdir(), 'cockpit-download-retry-test-'))
const saved = { ...NET_RETRY }

beforeAll(async () => {
  Object.assign(NET_RETRY, { baseDelayMs: 1, maxDelayMs: 50, textTimeoutMs: 200, downloadTimeoutMs: 200 })
  server = createServer((req, res) => {
    const n = hits.get(req.url!) ?? 0
    hits.set(req.url!, n + 1)
    const steps = scripts.get(req.url!) ?? []
    ;(steps[n] ?? steps[steps.length - 1] ?? status(404))(res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  Object.assign(NET_RETRY, saved)
  server.closeAllConnections()
  server.close()
  rmSync(root, { recursive: true, force: true })
})

describe('runtime downloads retry transient failures', () => {
  it('retries 429 and 503 until the answer comes', async () => {
    scripts.set('/channel', [status(429), status(503), ok(' 1.2.3\n')])
    expect(await fetchText(`${base}/channel`)).toBe('1.2.3')
    expect(hits.get('/channel')).toBe(3)
  })

  it('honours Retry-After, capped by maxDelayMs', async () => {
    scripts.set('/after', [status(429, { 'retry-after': '3600' }), ok('x')])
    const start = Date.now()
    expect(await fetchText(`${base}/after`)).toBe('x')
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('starts a download over after the connection breaks off', async () => {
    scripts.set('/bin', [cutOff, ok('the whole binary')])
    const file = join(root, 'bin')
    await downloadTo(`${base}/bin`, file)
    expect(readFileSync(file, 'utf8')).toBe('the whole binary')
    expect(hits.get('/bin')).toBe(2)
  })

  it('retries a request that stalls past its timeout', async () => {
    scripts.set('/stall', [silent, ok('late but there')])
    expect(await fetchText(`${base}/stall`)).toBe('late but there')
    scripts.set('/stall-bin', [silent, ok('binary')])
    await downloadTo(`${base}/stall-bin`, join(root, 'stall-bin'))
    expect(readFileSync(join(root, 'stall-bin'), 'utf8')).toBe('binary')
  })

  it('fails at once on a 404', async () => {
    scripts.set('/missing', [status(404)])
    await expect(fetchText(`${base}/missing`)).rejects.toThrow(/HTTP 404$/)
    expect(hits.get('/missing')).toBe(1)
  })

  it('gives up after NET_RETRY.attempts and says so', async () => {
    scripts.set('/busy', [status(429)])
    await expect(downloadTo(`${base}/busy`, join(root, 'busy'))).rejects.toThrow(`download → HTTP 429 (after ${NET_RETRY.attempts} attempts)`)
    expect(hits.get('/busy')).toBe(NET_RETRY.attempts)
  })
})
