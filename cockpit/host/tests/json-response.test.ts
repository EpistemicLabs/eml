import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'

import { acceptsGzip, GZIP_MIN_BYTES, sendJson } from '../src/json-response.js'

// The host's JSON answers go gzipped to a client that takes it: a page on the tailnet loaded the ~300 KB task board
// uncompressed on every change.

const big = { tasks: Array.from({ length: 200 }, (_, i) => ({ id: `task-${i}`, title: 'a task with a title that repeats' })) }
const small = { ok: true }

let server: http.Server
let base = ''
beforeAll(async () => {
  server = http.createServer((req, res) => sendJson(res, 200, req.url === '/big' ? big : small))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

/** A raw GET, so nothing decodes the body on the way. */
function get(path: string, encoding?: string): Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, { headers: encoding ? { 'Accept-Encoding': encoding } : {} }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

describe('JSON answers', () => {
  it('go gzipped to a client that takes gzip, and decode to the same payload', async () => {
    const { headers, body } = await get('/big', 'gzip, deflate, br')
    expect(headers['content-encoding']).toBe('gzip')
    expect(headers.vary).toBe('Accept-Encoding')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(zlib.gunzipSync(body).toString('utf8'))).toEqual(big)
    expect(body.length).toBeLessThan(JSON.stringify(big).length / 4)
  })

  it('go as they are to a client that does not take gzip', async () => {
    const { headers, body } = await get('/big')
    expect(headers['content-encoding']).toBeUndefined()
    expect(JSON.parse(body.toString('utf8'))).toEqual(big)
  })

  it('go as they are when they are small', async () => {
    expect(JSON.stringify(small).length).toBeLessThan(GZIP_MIN_BYTES)
    const { headers, body } = await get('/small', 'gzip')
    expect(headers['content-encoding']).toBeUndefined()
    expect(JSON.parse(body.toString('utf8'))).toEqual(small)
  })
})

describe('whether a request takes gzip', () => {
  const req = (value?: string) => ({ headers: value === undefined ? {} : { 'accept-encoding': value } }) as http.IncomingMessage
  it('reads Accept-Encoding, q=0 included', () => {
    expect(acceptsGzip(req('gzip'))).toBe(true)
    expect(acceptsGzip(req('br, GZIP;q=0.8'))).toBe(true)
    expect(acceptsGzip(req('*'))).toBe(true)
    expect(acceptsGzip(req('gzip;q=0'))).toBe(false)
    expect(acceptsGzip(req('br, deflate'))).toBe(false)
    expect(acceptsGzip(req())).toBe(false)
    expect(acceptsGzip(undefined)).toBe(false)
  })
})
