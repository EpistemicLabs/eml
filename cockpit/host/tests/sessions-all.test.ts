import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-sessions-all-test-'))
process.env.EML_COCKPIT_HOME = home

const MAIN = 'main-brain-id'
const OTHER = 'other-brain-id'
const PLAIN = 'plain-brain-id'
const SECRET = 'eml_testprefix_testsecret'

const fakeSpace = (id: string, name: string, fields: { main?: boolean; brainName?: string; agentId?: string; projectPath: string }) => ({
  id,
  name,
  brainName: fields.brainName ?? 'first-agent',
  main: fields.main ?? false,
  agent: fields.agentId ? { id: fields.agentId } : null,
  ledgerKey: fields.main ? null : id,
  url: 'http://127.0.0.1:1',
  token: SECRET,
  registry: { get: (projectId: string) => ({ projectId, path: `${fields.projectPath}/${projectId}` }) },
  notes: { subscribe: () => () => {} },
})

describe('sessions across spaces', () => {
  let server: Server
  let base: string
  const deleteTranscript = vi.fn()

  beforeAll(async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const { BrainSpaces } = await import('../src/brain-space.js')
    const { TurnTracker } = await import('../src/turn-state.js')
    const { createHostServer } = await import('../src/http.js')
    const ledger = new SessionLedger()
    ledger.recordSpawn('in-main', null, 'p1', 'claude')
    ledger.recordSpawn('in-other', null, 'p2', 'claude', false, null, OTHER)
    const turns = new TurnTracker()
    turns.apply({ sessionId: 'in-other', state: 'waiting' })
    const spaces = new BrainSpaces(fakeSpace(MAIN, 'Main', { main: true, projectPath: '/main' }) as never)
    spaces.add(fakeSpace(OTHER, 'Other', { agentId: 'second-agent', projectPath: '/other' }) as never)
    spaces.add(fakeSpace(PLAIN, 'Plain', { projectPath: '/plain' }) as never)
    const provider = {
      id: 'claude',
      summary: () => ({ messageCount: 1, lastMessageAt: null, lastActivity: null, summary: 'A session', aiTitle: null, model: null, contextTokens: null }),
      deleteTranscript,
    }
    const deps = {
      spaces,
      turns,
      providers: { forSession: () => provider, all: () => [provider] },
      bridge: {
        ledger,
        sessionRef: (sessionId: string, projectPath: string | null) => ({ sessionId, projectPath }),
        sessionState: () => 'ended',
        killSession: () => {},
      },
      chat: { isRunning: () => false, kill: async () => {} },
      spawns: { on: () => {}, off: () => {} },
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

  const write = (method: string, path: string, body?: unknown, space?: string) => fetch(`${base}${path}`, {
    method,
    headers: { origin: 'http://cockpit.test', 'content-type': 'application/json', ...(space ? { 'x-cockpit-space': space } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  it('lists the sessions of every space with the space they belong to', async () => {
    const res = await fetch(`${base}/api/sessions/all`)
    const { sessions } = await res.json() as { sessions: Array<{ id: string; spaceId: string; turnState: string }> }
    const byId = new Map(sessions.map((s) => [s.id, s]))
    expect(byId.get('in-main')?.spaceId).toBe(MAIN)
    expect(byId.get('in-other')?.spaceId).toBe(OTHER)
    expect(byId.get('in-other')?.turnState).toBe('waiting')
  })

  it('gives the same list whichever space the tab shows, and never a token', async () => {
    const res = await fetch(`${base}/api/sessions/all`, { headers: { 'x-cockpit-space': OTHER } })
    const text = await res.text()
    expect((JSON.parse(text) as { sessions: unknown[] }).sessions.length).toBeGreaterThanOrEqual(2)
    expect(text).not.toContain(SECRET)
  })

  it('labels a space by its agent, main by its brain name, any other by its own name', async () => {
    const res = await fetch(`${base}/api/spaces`)
    const text = await res.text()
    const { spaces } = JSON.parse(text) as { spaces: Array<{ id: string; label: string }> }
    expect(spaces.find((s) => s.id === MAIN)?.label).toBe('First-agent')
    expect(spaces.find((s) => s.id === OTHER)?.label).toBe('Second-agent')
    expect(spaces.find((s) => s.id === PLAIN)?.label).toBe('Plain')
    expect(text).not.toContain(SECRET)
  })

  it('renames a session of another space while the tab shows main', async () => {
    const res = await write('PATCH', '/api/sessions/in-other', { title: 'Renamed' })
    expect(res.status).toBe(200)
    const { session } = await res.json() as { session: { title: string } }
    expect(session.title).toBe('Renamed')
  })

  it('deletes the transcript in the session\'s own project, not the shown space\'s', async () => {
    const res = await write('DELETE', '/api/sessions/in-other')
    expect(res.status).toBe(200)
    expect(deleteTranscript).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'in-other', projectPath: '/other/p2' }))
  })
})
