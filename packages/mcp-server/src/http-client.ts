/**
 * Thin fetch wrapper for the EML HTTP API (v0.9-PROPOSAL §6.2).
 *
 * Deliberately lives without an `@engramprotocol/core` dependency — the MCP
 * server ships as a small npm package (`@engramprotocol/mcp-server`) that
 * only needs the SDK + zod + this file.
 *
 * Error handling: all failures throw `EmlApiError`. Tools catch it in the
 * handler and map to an `isError: true` result (see v0.9-PROPOSAL §6.4
 * "Error handling — two channels").
 */

export interface HttpClientOptions {
  url: string                              // e.g. http://localhost:3117
  token: string                            // Bearer secret without the "Bearer " prefix
  timeoutMs?: number                       // default 30s
}

export class EmlApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message)
    this.name = 'EmlApiError'
  }
}

export class HttpClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.url.replace(/\/+$/, '')
    this.headers = {
      'Authorization': `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    }
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  async get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', this.buildPath(path, query))
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    return this.request('POST', path, body)
  }

  async put(path: string, body?: unknown): Promise<unknown> {
    return this.request('PUT', path, body)
  }

  private buildPath(path: string, query?: Record<string, string | number | undefined>): string {
    if (!query) return path
    const params: string[] = []
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      params.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    }
    return params.length ? `${path}?${params.join('&')}` : path
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      const text = await res.text()
      let parsed: unknown = null
      if (text) {
        try { parsed = JSON.parse(text) } catch { parsed = text }
      }
      if (!res.ok) {
        const msg = extractErrorMessage(parsed) ?? `HTTP ${res.status}`
        throw new EmlApiError(res.status, parsed, `${method} ${path} → ${res.status}: ${msg}`)
      }
      return parsed
    } catch (err: unknown) {
      if (err instanceof EmlApiError) throw err
      const e = err as Error & { name?: string }
      if (e.name === 'AbortError') {
        throw new EmlApiError(0, null, `${method} ${path} timed out after ${this.timeoutMs}ms`)
      }
      throw new EmlApiError(0, null, `${method} ${path} failed: ${e.message}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as { error: unknown }).error
    return typeof e === 'string' ? e : JSON.stringify(e)
  }
  return null
}
