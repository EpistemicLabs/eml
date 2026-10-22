import http from 'http'
import type { EngramInput } from '@engramprotocol/core'

// HTTP helpers for the server E2E tests (they spawn the built server).

export interface HttpResult { status: number, body: any }

export function request(method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8')
          const parsed = text ? JSON.parse(text) : null
          resolve({ status: res.statusCode || 0, body: parsed })
        } catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
    req.setTimeout(3000, () => req.destroy(new Error('request timeout')))
  })
}

/** v0.19: an engram input (core fixtures) as the flat body of POST /engram/<type>. */
export function flat(input: EngramInput): { type: string, body: Record<string, unknown> } {
  const { type, properties, ...rest } = input
  return { type, body: { ...rest, ...(properties ?? {}) } }
}

export function waitForReady(port: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume()
        if (res.statusCode === 200) resolve()
        else if (Date.now() - start > timeoutMs) reject(new Error(`health=${res.statusCode}`))
        else setTimeout(tick, 100)
      })
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('server never came up'))
        else setTimeout(tick, 100)
      })
    }
    tick()
  })
}

