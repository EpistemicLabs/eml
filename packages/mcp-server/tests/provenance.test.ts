import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Provenance, lastModelIn } from '../src/provenance'
import { HttpClient } from '../src/http-client'

// v0.19 (B3): session, harness and model stamped on every write.

describe('Provenance — session id', () => {
  it('prefers the cockpit session, then Claude Code\'s, else one id per process', () => {
    expect(new Provenance({ COCKPIT_SESSION_ID: 'c1', CLAUDE_CODE_SESSION_ID: 'cc1' }).sessionId).toBe('c1')
    expect(new Provenance({ CLAUDE_CODE_SESSION_ID: 'cc1' }).sessionId).toBe('cc1')
    const a = new Provenance({}).sessionId
    expect(a).toMatch(/^process-[0-9a-f-]{36}$/)
    expect(new Provenance({}).sessionId).not.toBe(a)
  })
})

describe('Provenance — harness', () => {
  it('comes from the client name once set; blank names are ignored', () => {
    const p = new Provenance({})
    expect(p.harness).toBeNull()
    p.setHarness('  ')
    expect(p.harness).toBeNull()
    p.setHarness('claude-code')
    expect(p.harness).toBe('claude-code')
  })
})

describe('Provenance — model', () => {
  let dir: string
  let cwd: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eml-prov-'))
    cwd = process.cwd()
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('asks the cockpit host with the spawn token', async () => {
    const seen: Array<{ url: string, token: unknown }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), token: (init?.headers as Record<string, string>)['x-cockpit-token'] })
      return new Response(JSON.stringify({ model: 'claude-opus-5-5' }), { status: 200 })
    }) as unknown as typeof fetch
    const p = new Provenance({ COCKPIT_URL: 'http://127.0.0.1:4318/', COCKPIT_SPAWN_TOKEN: 'tok', COCKPIT_SESSION_ID: 's 1' }, fetchImpl)
    expect(await p.model()).toBe('claude-opus-5-5')
    expect(seen).toEqual([{ url: 'http://127.0.0.1:4318/api/session-model/s%201', token: 'tok' }])
    // cached: no second request within the window
    await p.model()
    expect(seen).toHaveLength(1)
  })

  it('stays unknown when the host answers without a model or fails', async () => {
    const empty = (async () => new Response(JSON.stringify({ model: null }), { status: 200 })) as unknown as typeof fetch
    expect(await new Provenance({ COCKPIT_URL: 'http://h', COCKPIT_SPAWN_TOKEN: 't', COCKPIT_SESSION_ID: 's' }, empty).model()).toBeNull()
    const down = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await new Provenance({ COCKPIT_URL: 'http://h', COCKPIT_SPAWN_TOKEN: 't', COCKPIT_SESSION_ID: 's' }, down).model()).toBeNull()
  })

  it('outside the cockpit reads the last assistant model from Claude Code\'s transcript', async () => {
    const projectDir = path.join(dir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'cc-1.jsonl'), [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5' } }),
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } }),
      '{"type":"assistant","message":{"mod',
    ].join('\n'))
    const p = new Provenance({ CLAUDE_CODE_SESSION_ID: 'cc-1', CLAUDE_CONFIG_DIR: dir })
    expect(await p.model()).toBe('claude-opus-5-5')
    expect(await new Provenance({ CLAUDE_CODE_SESSION_ID: 'missing', CLAUDE_CONFIG_DIR: dir }).model()).toBeNull()
  })

  it('lastModelIn returns null for a missing file or no model', () => {
    expect(lastModelIn(path.join(dir, 'nope.jsonl'))).toBeNull()
    const f = path.join(dir, 'x.jsonl')
    fs.writeFileSync(f, JSON.stringify({ type: 'user' }) + '\n')
    expect(lastModelIn(f)).toBeNull()
  })

  it('headers: session + ingestion always, harness and model when known', async () => {
    const p = new Provenance({ CLAUDE_CODE_SESSION_ID: 'none', CLAUDE_CONFIG_DIR: dir })
    expect(await p.headers()).toEqual({ 'X-EML-Session': 'none', 'X-EML-Ingestion': 'mcp' })
    p.setHarness('codex')
    expect((await p.headers())['X-EML-Harness']).toBe('codex')
  })
})

describe('HttpClient writeHeaders', () => {
  const original = global.fetch
  afterEach(() => { global.fetch = original; vi.restoreAllMocks() })

  it('adds them to writes (POST / PUT) only, not to reads', async () => {
    const seen: Array<{ method: string, session: unknown }> = []
    global.fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ method: String(init?.method), session: (init?.headers as Record<string, string>)['X-EML-Session'] })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const c = new HttpClient({ url: 'http://x', token: 't', writeHeaders: async () => ({ 'X-EML-Session': 's1' }) })
    await c.get('/list')
    await c.post('/engram/note', {})
    await c.put('/object/tag/x', {})
    expect(seen).toEqual([
      { method: 'GET', session: undefined },
      { method: 'POST', session: 's1' },
      { method: 'PUT', session: 's1' },
    ])
  })

  it('a failing header provider does not fail the write', async () => {
    global.fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch
    const c = new HttpClient({ url: 'http://x', token: 't', writeHeaders: async () => { throw new Error('boom') } })
    expect(await c.post('/engram/note', {})).toEqual({ ok: true })
  })
})
