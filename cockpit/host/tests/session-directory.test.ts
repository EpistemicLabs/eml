import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatEntry, formatShort, LIST_BUDGET, listAgentsContext, recentSessions, searchResult, searchSessions, when, type DirectoryEntry,
} from '../src/domain/session-directory.js'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-session-directory-test-'))
process.env.EML_COCKPIT_HOME = home

const NOW = Date.parse('2026-06-10T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

const entry = (fields: Partial<DirectoryEntry> & { address: string }): DirectoryEntry => ({
  name: '', outcome: null, asked: null, project: null, state: 'stopped', lastActive: hoursAgo(1), parent: null, main: false, ...fields,
})

describe('searching sessions', () => {
  const sessions = [
    entry({ address: 'shop-1', name: 'Catalogue import', project: 'Shop', lastActive: hoursAgo(30) }),
    entry({ address: 'shop-2', name: 'Fix invoices', asked: 'Fix the invoice export to the catalogue team', outcome: 'Export fixed, PR open', lastActive: hoursAgo(2) }),
    entry({ address: 'shop-3', name: 'Old catalogue', state: 'archived', lastActive: hoursAgo(1) }),
    entry({ address: 'shop-4', name: 'Release', state: 'running', project: 'Platform', lastActive: hoursAgo(5) }),
  ]

  it('finds a session by a word of its name, its request or its last status', () => {
    expect(searchSessions(sessions, { words: ['invoice', 'export'] }).map((s) => s.address)).toEqual(['shop-2'])
    expect(searchSessions(sessions, { words: ['PR', 'open'] }).map((s) => s.address)).toEqual(['shop-2'])
  })

  it('puts a match in the name before a more recent match elsewhere', () => {
    expect(searchSessions(sessions, { words: ['catalogue'] }).map((s) => s.address)).toEqual(['shop-1', 'shop-2'])
  })

  it('needs every word, ignores case and accents', () => {
    expect(searchSessions(sessions, { words: ['CATALOGUE', 'import'] }).map((s) => s.address)).toEqual(['shop-1'])
    expect(searchSessions([entry({ address: 'a', name: 'Kündigung' })], { words: ['kundigung'] })).toHaveLength(1)
    expect(searchSessions(sessions, { words: ['catalogue', 'nothing'] })).toEqual([])
  })

  it('leaves archived sessions out unless asked', () => {
    expect(searchSessions(sessions, { words: ['old'] })).toEqual([])
    expect(searchSessions(sessions, { words: ['old'], archived: true }).map((s) => s.address)).toEqual(['shop-3'])
  })

  it('filters by state and project, and caps the result', () => {
    expect(searchSessions(sessions, { words: [], state: 'running' }).map((s) => s.address)).toEqual(['shop-4'])
    expect(searchSessions(sessions, { words: [], project: 'shop' }).map((s) => s.address)).toEqual(['shop-1'])
    expect(searchSessions(sessions, { words: [], limit: 2 })).toHaveLength(2)
  })

  it('tells the agent to ask its user when more than one fits, and what to try when none does', () => {
    const many = searchResult(searchSessions(sessions, { words: ['catalogue'] }), { words: ['catalogue'] })
    expect(many).toContain('ranked by how well the name matches')
    expect(many).toContain('numbered list')
    expect(many).toContain('shop-1')
    expect(searchResult(searchSessions(sessions, { words: ['import'] }), { words: ['import'] })).toMatch(/^One session fits:/)
    const none = searchResult([], { words: ['zebra'] })
    expect(none).toContain('No session matches "zebra"')
    expect(none).toContain('node "$COCKPIT_SESSIONS_JS" <words> --archived')
  })
})

describe('the list after ListAgents', () => {
  it('puts the main sessions first however old, then the most recent, never archived ones', () => {
    const sessions = [
      ...Array.from({ length: 3 }, (_, i) => entry({ address: `s-${i}`, lastActive: hoursAgo(i) })),
      entry({ address: 'pinned-old', main: true, lastActive: hoursAgo(500) }),
      entry({ address: 'archived', state: 'archived', lastActive: hoursAgo(0) }),
    ]
    expect(recentSessions(sessions).map((s) => s.address)).toEqual(['pinned-old', 's-0', 's-1', 's-2'])
  })

  it('says stopped sessions are reachable, how to search, and lists each with its address', () => {
    const at = hoursAgo(1)
    const text = listAgentsContext([entry({ address: 'shop-1', name: 'Catalogue import', asked: 'Import the catalogue', outcome: 'Done', lastActive: at })])
    expect(text).toMatch(/^Showing 1 of 1 cockpit sessions/)
    expect(text).toContain('Stopped ones work too')
    expect(text).toContain('node "$COCKPIT_SESSIONS_JS" <words from what your user called it>')
    expect(text).toContain('numbered list')
    expect(text).toContain(`shop-1 · stopped · ${when(at)} · "Catalogue import" — last: Done`)
  })

  it('stays under Claude Code\'s cap for hook context, however many sessions there are', () => {
    const many = Array.from({ length: 300 }, (_, i) => entry({
      address: `eml-${String(i).padStart(8, '0')}`, name: `Session about topic ${i} `.repeat(4), project: 'Some project',
      asked: 'A long first prompt that goes on and on '.repeat(5), outcome: 'A long status reason '.repeat(5), lastActive: hoursAgo(i),
    }))
    const text = listAgentsContext(many)
    expect(text.length).toBeLessThanOrEqual(LIST_BUDGET)
    const shown = Number(text.match(/^Showing (\d+) of 300/)?.[1])
    expect(shown).toBeGreaterThan(55)
    expect(text.split('\n').filter((line) => line.startsWith('eml-'))).toHaveLength(shown)
  })

  it('keeps an entry short, and fits about 65 typical ones', () => {
    const typical = entry({ address: 'eml-1a2b3c4d', name: 'Fix the invoice export now', project: 'EML (Engram Protocol)', outcome: 'Export fixed and tested; PR is open for review by the team' })
    expect(Math.floor(LIST_BUDGET / (formatShort(typical).length + 1))).toBeGreaterThanOrEqual(60)
    expect(formatShort(entry({ address: 'a', name: 'Same', asked: 'Same' }))).toBe(`a · stopped · ${when(hoursAgo(1))} · "Same"`)
    expect(formatShort(entry({ address: 'a', name: 'x'.repeat(200), asked: 'y'.repeat(200) })).length).toBeLessThan(130)
    expect(formatShort(entry({ address: 'eml-1a2b3c4d', name: 'x'.repeat(200), project: 'p'.repeat(100), outcome: 'y'.repeat(200) })).length).toBeLessThanOrEqual(160)
    expect(formatEntry(entry({ address: 'a', name: 'n', asked: 'q', outcome: 'r' }))).toContain('\n  asked: q | last: r')
  })
})

describe('the session directory endpoint', () => {
  let server: Server
  let base: string
  const get = (query: string, headers: Record<string, string> = { 'x-cockpit-token': 'spawn-token', 'x-cockpit-session': 'caller' }) =>
    fetch(`${base}/api/session-directory${query}`, { headers })

  beforeAll(async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const { BrainSpaces } = await import('../src/brain-space.js')
    const { TurnTracker } = await import('../src/turn-state.js')
    const { createHostServer } = await import('../src/http.js')
    const ledger = new SessionLedger()
    ledger.recordSpawn('caller', null, 'p1', 'claude')
    ledger.recordSpawn('catalogue-session', null, 'p1', 'claude')
    ledger.setAgentTitle('catalogue-session', 'Catalogue import')
    ledger.setAttention('catalogue-session', { kind: 'review', reason: 'Import ran, 12 products need a look' })
    ledger.setAttention('catalogue-session', null)
    ledger.recordSpawn('shared-space', null, 'p1', 'claude', false, null, 'shared-brain')
    ledger.recordSpawn('other-agent', null, 'p1', 'claude', false, null, 'agent-brain')
    ledger.recordSpawn('codex-session', null, 'p1', 'codex')
    const space = (id: string, agentId: string | null) => ({
      id, name: id, brainName: 'agent', main: id === 'main', agent: agentId ? { id: agentId } : null, ledgerKey: id === 'main' ? null : id,
      url: 'http://127.0.0.1:1', token: 'secret',
      registry: { get: (projectId: string) => ({ projectId, path: `/work/${projectId}`, displayName: 'Shop', customName: null }) },
      notes: { subscribe: () => () => {} },
    })
    const spaces = new BrainSpaces(space('main', null) as never)
    spaces.add(space('shared-brain', null) as never)
    spaces.add(space('agent-brain', 'second-agent') as never)
    const provider = (id: string, messaging: boolean) => ({
      id, messaging, deleteTranscript: () => {},
      summary: (ref: { sessionId: string }) => ({ messageCount: 2, lastMessageAt: hoursAgo(3), lastActivity: null, summary: ref.sessionId === 'catalogue-session' ? 'Import the spring catalogue' : 'Something else', aiTitle: null, model: null, contextTokens: null }),
    })
    const claude = provider('claude', true)
    const codex = provider('codex', false)
    const deps = {
      spaces,
      turns: new TurnTracker(),
      providers: { forSession: (sessionId: string) => (sessionId === 'codex-session' ? codex : claude), all: () => [claude, codex] },
      bridge: { ledger, sessionRef: (sessionId: string, projectPath: string | null) => ({ sessionId, projectPath }), sessionState: () => 'ended' },
      chat: { isRunning: () => false },
      spawns: { on: () => {}, off: () => {}, list: () => [] },
      spawnToken: 'spawn-token',
      hookToken: 'hook-token',
      turnHookConfig: '',
    }
    server = createHostServer(deps as never, ['http://cockpit.test'])
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(home, { recursive: true, force: true })
  })

  it('answers only a cockpit session that says who it is', async () => {
    expect((await get('', {})).status).toBe(403)
    expect((await get('', { 'x-cockpit-token': 'wrong', 'x-cockpit-session': 'caller' })).status).toBe(403)
    expect((await get('', { 'x-cockpit-token': 'spawn-token' })).status).toBe(403)
  })

  it('finds a stopped session by its name, with its request and the status it gave before it was seen', async () => {
    const { text } = await (await get('?q=catalogue%20import')).json() as { text: string }
    expect(text).toContain('One session fits')
    expect(text).toContain('"Catalogue import"')
    expect(text).toContain('stopped')
    expect(text).toContain('Shop')
    expect(text).toContain('asked: Import the spring catalogue')
    expect(text).toContain('last: Import ran, 12 products need a look')
  })

  it('lists what SendMessage reaches: the same agent across spaces, not the caller, another agent or Codex', async () => {
    const { text } = await (await get('?list=recent')).json() as { text: string }
    const { sessionAddress } = await import('../src/session-address.js')
    expect(text).toContain(sessionAddress('catalogue-session', 'p1'))
    expect(text).toContain(sessionAddress('shared-space', 'p1'))
    expect(text).not.toContain(sessionAddress('caller', 'p1'))
    expect(text).not.toContain(sessionAddress('other-agent', 'p1'))
    expect(text).not.toContain(sessionAddress('codex-session', 'p1'))
    expect(text).not.toContain('secret')
  })
})

describe('the ListAgents hook', () => {
  const HOOK = join(__dirname, '..', 'src', 'list-agents-hook.ts')
  const runHook = (env: Record<string, string>) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const { COCKPIT_URL: _url, COCKPIT_SPAWN_TOKEN: _token, COCKPIT_SESSION_ID: _session, ...rest } = process.env
    const child = spawn(process.execPath, ['--import', 'tsx', HOOK], { env: { ...rest, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.on('close', (code) => resolve({ code, out }))
    child.stdin.end(JSON.stringify({ tool_name: 'ListAgents', tool_input: {} }))
  })
  const withHost = async (status: number, body: string, run: (url: string, seen: IncomingHttpHeaders[]) => Promise<void>) => {
    const seen: IncomingHttpHeaders[] = []
    const host = createServer((req, res) => { seen.push(req.headers); res.statusCode = status; res.end(body) })
    await new Promise<void>((r) => host.listen(0, '127.0.0.1', r))
    try { await run(`http://127.0.0.1:${(host.address() as AddressInfo).port}`, seen) } finally { host.close() }
  }

  it('adds the host\'s list to the result as context', async () => {
    await withHost(200, JSON.stringify({ text: 'Cockpit sessions you can message' }), async (url, seen) => {
      const { code, out } = await runHook({ COCKPIT_URL: url, COCKPIT_SPAWN_TOKEN: 'token-1', COCKPIT_SESSION_ID: 'session-1' })
      expect(code).toBe(0)
      expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Cockpit sessions you can message' } })
      expect(seen[0]['x-cockpit-token']).toBe('token-1')
      expect(seen[0]['x-cockpit-session']).toBe('session-1')
    })
  })

  it('adds nothing and exits 0 when the host refuses or is gone', async () => {
    await withHost(403, '{}', async (url) => {
      expect(await runHook({ COCKPIT_URL: url, COCKPIT_SPAWN_TOKEN: 't', COCKPIT_SESSION_ID: 's' })).toEqual({ code: 0, out: '' })
    })
    expect(await runHook({ COCKPIT_URL: 'http://127.0.0.1:1', COCKPIT_SPAWN_TOKEN: 't', COCKPIT_SESSION_ID: 's' })).toEqual({ code: 0, out: '' })
    expect(await runHook({})).toEqual({ code: 0, out: '' })
  })
})
