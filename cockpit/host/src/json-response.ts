import type http from 'node:http'
import zlib from 'node:zlib'

/** Smaller bodies go as they are: compressing them saves nothing worth the work. */
export const GZIP_MIN_BYTES = 1024

/** Whether the request takes gzip (Accept-Encoding names it without q=0). */
export function acceptsGzip(req: http.IncomingMessage | undefined): boolean {
  const header = req?.headers['accept-encoding']
  const value = Array.isArray(header) ? header.join(',') : header ?? ''
  return value.split(',').some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';').map((p) => p.trim())
    if (name !== 'gzip' && name !== '*') return false
    const q = params.find((p) => p.startsWith('q='))
    return !q || Number(q.slice(2)) > 0
  })
}

/**
 * Answer with JSON, gzipped when the client takes it and the body is big enough. Pages reach the cockpit over the
 * tailnet too, where the task board (~300 KB) and the session list (~550 KB) are a fifth of that compressed.
 * Compression runs off the event loop; if it fails, the body goes uncompressed.
 */
export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  if (body.length < GZIP_MIN_BYTES || !acceptsGzip(res.req)) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...(body.length >= GZIP_MIN_BYTES ? { Vary: 'Accept-Encoding' } : {}) })
    res.end(body)
    return
  }
  zlib.gzip(body, { level: 6 }, (err, zipped) => {
    if (err) {
      res.writeHead(status, { 'Content-Type': 'application/json', Vary: 'Accept-Encoding' })
      res.end(body)
      return
    }
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' })
    res.end(zipped)
  })
}
