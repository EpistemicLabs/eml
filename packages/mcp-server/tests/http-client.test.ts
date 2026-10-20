import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HttpClient, EmlApiError } from '../src/http-client'

describe('HttpClient', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): void {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      return impl(String(input), init ?? {})
    }) as unknown as typeof fetch
  }

  describe('GET', () => {
    it('sends Bearer + json header, returns parsed body', async () => {
      let capturedHeaders: Record<string, string> = {}
      mockFetch((url, init) => {
        expect(url).toBe('http://localhost:3117/agents')
        capturedHeaders = init.headers as Record<string, string>
        return new Response(JSON.stringify({ count: 0, agents: [] }), { status: 200 })
      })
      const c = new HttpClient({ url: 'http://localhost:3117', token: 'eml_abc' })
      const r = await c.get('/agents') as { count: number, agents: unknown[] }
      expect(r.count).toBe(0)
      expect(capturedHeaders.Authorization).toBe('Bearer eml_abc')
      expect(capturedHeaders['Content-Type']).toBe('application/json')
    })

    it('encoded query params', async () => {
      mockFetch((url) => {
        expect(url).toBe('http://localhost:3117/list?type=decision&limit=10')
        return new Response('[]', { status: 200 })
      })
      const c = new HttpClient({ url: 'http://localhost:3117', token: 't' })
      await c.get('/list', { type: 'decision', limit: 10, omitMe: undefined })
    })

    it('strips trailing slashes from baseUrl', async () => {
      mockFetch((url) => {
        expect(url).toBe('http://localhost:3117/health')
        return new Response('{}', { status: 200 })
      })
      const c = new HttpClient({ url: 'http://localhost:3117///', token: 't' })
      await c.get('/health')
    })
  })

  describe('POST', () => {
    it('serializes body, returns parsed result', async () => {
      mockFetch((_url, init) => {
        const body = JSON.parse(String(init.body))
        expect(body).toEqual({ agent: 'assistant' })
        return new Response(JSON.stringify({ engrams: 3 }), { status: 200 })
      })
      const c = new HttpClient({ url: 'http://x', token: 't' })
      const r = await c.post('/boot', { agent: 'assistant' }) as { engrams: number }
      expect(r.engrams).toBe(3)
    })

    it('v0.19: writeHeaders ride on writes only — not on GET, /boot or /recall', async () => {
      const seen: Array<{ url: string, session: string | undefined }> = []
      mockFetch((url, init) => {
        seen.push({ url, session: (init.headers as Record<string, string>)['X-EML-Session'] })
        return new Response('{}', { status: 200 })
      })
      const writeHeaders = vi.fn(async () => ({ 'X-EML-Session': 'sess-1' }))
      const c = new HttpClient({ url: 'http://x', token: 't', writeHeaders })
      await c.get('/list')
      await c.post('/boot', {})
      await c.post('/recall', { query: 'x' })
      await c.post('/engram/note', { scope: 'global' })
      await c.put('/object/project/p', { name: 'P' })
      expect(seen.map((s) => s.session)).toEqual([undefined, undefined, undefined, 'sess-1', 'sess-1'])
      expect(writeHeaders).toHaveBeenCalledTimes(2)
    })

    it('a failing writeHeaders lookup does not block the write', async () => {
      mockFetch(() => new Response('{}', { status: 200 }))
      const c = new HttpClient({ url: 'http://x', token: 't', writeHeaders: async () => { throw new Error('no session') } })
      await expect(c.post('/engram/note', {})).resolves.toEqual({})
    })
  })

  describe('errors', () => {
    it('non-2xx → EmlApiError with status + body + extracted message', async () => {
      mockFetch(() => new Response(JSON.stringify({ error: 'invalid token' }), { status: 401 }))
      const c = new HttpClient({ url: 'http://x', token: 't' })
      await expect(c.get('/list')).rejects.toMatchObject({
        name: 'EmlApiError',
        status: 401,
      })
      try {
        await c.get('/list')
      } catch (err) {
        const e = err as EmlApiError
        expect(e.status).toBe(401)
        expect((e.body as { error: string }).error).toBe('invalid token')
        expect(e.message).toContain('401')
        expect(e.message).toContain('invalid token')
      }
    })

    it('network error → EmlApiError(status=0)', async () => {
      mockFetch(() => { throw new Error('ECONNREFUSED') })
      const c = new HttpClient({ url: 'http://x', token: 't' })
      try {
        await c.get('/x')
        expect.fail('should have thrown')
      } catch (err) {
        const e = err as EmlApiError
        expect(e.status).toBe(0)
        expect(e.message).toContain('ECONNREFUSED')
      }
    })

    it('non-JSON body still surfaces status', async () => {
      mockFetch(() => new Response('Internal Server Error', { status: 500 }))
      const c = new HttpClient({ url: 'http://x', token: 't' })
      try {
        await c.get('/x')
        expect.fail('should have thrown')
      } catch (err) {
        const e = err as EmlApiError
        expect(e.status).toBe(500)
        expect(e.body).toBe('Internal Server Error')
      }
    })
  })
})
