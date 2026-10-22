import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrainSpace } from '../src/brain-space.js'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-session-title-test-'))
process.env.EML_COCKPIT_HOME = home
const TOKEN = 'spawn-token-of-this-boot'

describe('session title', () => {
  let greeting: typeof import('../src/session-greeting.js')
  let readSessionSummary: typeof import('../src/infrastructure/providers/claude/session-summary.js')['readSessionSummary']
  let transcriptPathFor: typeof import('../src/infrastructure/providers/claude/session-summary.js')['transcriptPathFor']
  let ledger: import('../src/session-ledger.js').SessionLedger

  beforeAll(async () => {
    greeting = await import('../src/session-greeting.js');
    ({ readSessionSummary, transcriptPathFor } = await import('../src/infrastructure/providers/claude/session-summary.js'))
    const { SessionLedger } = await import('../src/session-ledger.js')
    const { SpawnQueue } = await import('../src/spawn-queue.js')
    const { ProjectRegistry } = await import('../src/project-registry.js')
    const { ProviderRegistry } = await import('../src/infrastructure/providers/registry.js')
    const { BrainSpaces } = await import('../src/brain-space.js')
    const { watchSpawnInbox } = await import('../src/spawn-inbox.js')
    ledger = new SessionLedger()
    const main = { id: 'main', main: true, ledgerKey: null, registry: new ProjectRegistry(), projects: { list: async () => [] } } as unknown as BrainSpace
    watchSpawnInbox({ spawns: new SpawnQueue(), spawnToken: TOKEN, spaces: new BrainSpaces(main), ledger, providers: new ProviderRegistry({ providers: [] }) })
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('knows the greeting by the ledger, and by its text for sessions from before', () => {
    expect(greeting.firstPromptIsGreeting(true, 'anything')).toBe(true)
    expect(greeting.firstPromptIsGreeting(false, greeting.GREETING_PROMPT)).toBe(false)
    expect(greeting.firstPromptIsGreeting(null, greeting.GREETING_PROMPT)).toBe(true)
    // The v0.18.3 wording.
    expect(greeting.firstPromptIsGreeting(null, 'Session start: greet me briefly, say which project this session is in and where it stands (status, next step, open tasks).')).toBe(true)
    expect(greeting.firstPromptIsGreeting(null, 'Fix the session titles')).toBe(false)
  })

  describe('Claude Code transcript', () => {
    const project = '/Users/x/work/eml-app'
    const write = (sessionId: string, firstPrompt: string) => {
      const file = transcriptPathFor(project, sessionId)
      mkdirSync(dirname(file), { recursive: true })
      const user = (text: string) => JSON.stringify({ type: 'user', timestamp: '2026-10-22T10:00:00.000Z', message: { role: 'user', content: text } })
      writeFileSync(file, [
        user(firstPrompt),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Session start and project status' }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-10-22T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } }),
        user('seit der Umstellung sind die Session-Titel falsch\nmehr Text'),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Session start and project status' }),
      ].join('\n'))
    }

    it('drops the title Claude Code made from the greeting and summarises the user\'s first prompt', () => {
      write('greeted', greeting.GREETING_PROMPT)
      expect(readSessionSummary(project, 'greeted', true)).toMatchObject({
        aiTitle: null, summary: 'seit der Umstellung sind die Session-Titel falsch', messageCount: 3,
      })
      expect(readSessionSummary(project, 'greeted', null).aiTitle).toBeNull()
    })

    it('keeps Claude Code\'s title when the user wrote the first prompt', () => {
      write('plain', 'Release v0.19.2 review')
      expect(readSessionSummary(project, 'plain', false)).toMatchObject({
        aiTitle: 'Session start and project status', summary: 'Release v0.19.2 review',
      })
    })
  })

  describe('a session names itself through the inbox', () => {
    const inbox = join(home, 'spawn-inbox')
    const request = async (body: Record<string, unknown>) => {
      const id = randomUUID()
      writeFileSync(join(inbox, `${id}.json.tmp`), JSON.stringify(body))
      renameSync(join(inbox, `${id}.json.tmp`), join(inbox, `${id}.json`))
      const result = join(inbox, `${id}.result.json`)
      for (let i = 0; i < 100 && !existsSync(result); i++) await new Promise((r) => setTimeout(r, 50))
      return JSON.parse(readFileSync(result, 'utf8')) as { status: number; payload: Record<string, any> }
    }

    it('sets the agent title of its own session', async () => {
      ledger.recordSpawn('s-named', null, 'p1', 'codex', false, null, null, true)
      const outcome = await request({ kind: 'session-title', session: 's-named', title: '  Session   titles ', token: TOKEN })
      expect(outcome).toEqual({ status: 200, payload: { title: 'Session titles' } })
      expect(ledger.get('s-named')?.agentTitle).toBe('Session titles')
    })

    it('refuses without the token, for an unknown session and without a title', async () => {
      expect((await request({ kind: 'session-title', session: 's-named', title: 'x', token: 'guess' })).status).toBe(403)
      expect((await request({ kind: 'session-title', session: 'nope', title: 'x', token: TOKEN })).status).toBe(404)
      expect((await request({ kind: 'session-title', session: 's-named', title: ' ', token: TOKEN })).payload.error.code).toBe('INVALID_TITLE')
      expect((await request({ kind: 'session-title', session: 's-named', title: 'x'.repeat(61), token: TOKEN })).status).toBe(400)
      expect(ledger.get('s-named')?.agentTitle).toBe('Session titles')
    })
  })
})
