import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import './setup-home.js'
import { CONTENT_SECURITY_POLICY, serveStatic } from '../src/http.js'

async function headersFor(path: string): Promise<http.IncomingHttpHeaders> {
  const server = http.createServer(serveStatic)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`)
    await res.arrayBuffer()
    return Object.fromEntries(res.headers.entries())
  } finally {
    server.close()
  }
}

describe('Content-Security-Policy', () => {
  it('lets only the page\'s own images load', () => {
    expect(CONTENT_SECURITY_POLICY).toBe("img-src 'self' data: blob:")
  })

  it.each(['/', '/projects/p1', '/sw.js', '/does-not-exist.png'])('is sent with %s', async (path) => {
    expect((await headersFor(path))['content-security-policy']).toBe(CONTENT_SECURITY_POLICY)
  })
})
