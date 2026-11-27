import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, ProviderId, TurnSignal } from '../src/domain/agent-provider.js'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-session-identity-test-'))
process.env.EML_COCKPIT_HOME = home

// A session of each kind from before providers existed, plus one unknown provider.
writeFileSync(join(home, 'sessions.json'), JSON.stringify({
  version: 1,
  sessions: {
    legacy: { projectId: 'p1', createdAt: '2026-01-01T00:00:00.000Z', lastAttached: '2026-01-01T00:00:00.000Z' },
    odd: { provider: 'nope', createdAt: '2026-01-01T00:00:00.000Z', lastAttached: '2026-01-01T00:00:00.000Z' },
  },
}))

/** A provider that reads `{ id, state }` payloads; `adopts` decides whose session ids it uses. */
const fakeProvider = (adoptsSessionId: boolean): AgentProvider => ({
  id: 'claude' as ProviderId,
  adoptsSessionId,
  capabilities: { chat: { supported: true }, endTurnTool: { supported: true }, messaging: { supported: false, reason: 'no address' }, terminalTools: { supported: false, reason: 'built in' } },
  runtime: { problem: () => null },
  turnSignal: (payload): TurnSignal | null =>
    typeof payload.id === 'string'
      ? { kind: 'turn', providerSessionId: payload.id, state: payload.state as 'working' | 'done' | 'waiting', ...(payload.prompt === true ? { prompt: true as const } : {}) }
      : typeof payload.label === 'string' ? { kind: 'unclassified', label: payload.label } : null,
} as AgentProvider)

describe('session identity', () => {
  let SessionLedger: typeof import('../src/session-ledger.js')['SessionLedger']
  let ProviderRegistry: typeof import('../src/infrastructure/providers/registry.js')['ProviderRegistry']
  let TurnTracker: typeof import('../src/turn-state.js')['TurnTracker']
  let applySessionHook: typeof import('../src/application/apply-session-hook.js')['applySessionHook']

  beforeAll(async () => {
    ({ SessionLedger } = await import('../src/session-ledger.js'));
    ({ ProviderRegistry } = await import('../src/infrastructure/providers/registry.js'));
    ({ TurnTracker } = await import('../src/turn-state.js'));
    ({ applySessionHook } = await import('../src/application/apply-session-hook.js'))
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const setup = (adoptsSessionId: boolean) => {
    const ledger = new SessionLedger()
    const providers = new ProviderRegistry({ providerOf: (id) => ledger.get(id)?.provider, providers: [fakeProvider(adoptsSessionId)] })
    const turns = new TurnTracker()
    return { ledger, providers, turns, hook: (named: string | null, payload: Record<string, unknown>) => applySessionHook({ ledger, providers, turns }, named, payload) }
  }

  it('reads ledger entries from before providers existed as Claude Code sessions', () => {
    const ledger = new SessionLedger()
    expect(ledger.get('legacy')).toMatchObject({ provider: 'claude', providerSessionId: null, projectId: 'p1' })
    expect(ledger.get('odd')?.provider).toBe('claude')
    expect(ledger.ref('legacy', '/some/path')).toEqual({ sessionId: 'legacy', providerSessionId: null, projectPath: '/some/path', greeted: null })
  })

  it('records the greeting on the first spawn only, and keeps the agent\'s title apart from the user\'s', () => {
    const ledger = new SessionLedger()
    ledger.recordSpawn('s-greet', 'pane-1', 'p1', 'claude', false, null, null, true)
    // The resume-fallback respawn passes no greeting: the first spawn's answer stays.
    ledger.recordSpawn('s-greet', 'pane-1', 'p1', 'claude')
    expect(ledger.setAgentTitle('s-greet', '  Session titles after the greeting ')?.agentTitle).toBe('Session titles after the greeting')
    ledger.update('s-greet', { title: 'Mine' })
    expect(new SessionLedger().get('s-greet')).toMatchObject({ greeted: true, agentTitle: 'Session titles after the greeting', title: 'Mine' })
    expect(ledger.ref('s-greet', null).greeted).toBe(true)
    ledger.recordSpawn('s-plain', null, 'p1', 'claude')
    expect(ledger.get('s-plain')).toMatchObject({ greeted: false, agentTitle: null })
    expect(ledger.setAgentTitle('nope', 'x')).toBeUndefined()
  })

  it('keeps the provider and its session id across later spawns', () => {
    const ledger = new SessionLedger()
    ledger.recordSpawn('s-keep', 'pane-1', 'p1', 'claude')
    expect(ledger.bindProviderSession('s-keep', 'provider-id-1')).toBe(true)
    expect(ledger.bindProviderSession('s-keep', 'provider-id-1')).toBe(false)
    ledger.recordSpawn('s-keep', 'pane-2', 'p1', 'claude')
    expect(new SessionLedger().get('s-keep')).toMatchObject({ provider: 'claude', providerSessionId: 'provider-id-1', spawnCount: 2 })
  })

  it('binds a provider-assigned id from the first hook and keys turn state on the cockpit id', () => {
    const { ledger, turns, hook } = setup(false)
    ledger.recordSpawn('s-own', null, 'p1', 'claude')
    hook('s-own', { id: 'their-id', state: 'working' })
    expect(ledger.get('s-own')?.providerSessionId).toBe('their-id')
    expect(turns.get('s-own')?.state).toBe('working')
    expect(turns.get('their-id')).toBeUndefined()
  })

  it('drops hooks of another conversation that name the same cockpit session', () => {
    const { ledger, turns, hook } = setup(false)
    ledger.recordSpawn('s-nested', null, 'p1', 'claude')
    hook('s-nested', { id: 'outer', state: 'working' })
    hook('s-nested', { id: 'inner', state: 'done' })
    expect(ledger.get('s-nested')?.providerSessionId).toBe('outer')
    expect(turns.get('s-nested')?.state).toBe('working')
  })

  it('keeps the folder the agent works in from its hooks, not from another conversation\'s', () => {
    const { ledger, hook } = setup(false)
    ledger.recordSpawn('s-cwd', null, 'p1', 'claude')
    expect(ledger.get('s-cwd')?.workdir).toBeNull()
    hook('s-cwd', { id: 'outer', state: 'working', cwd: '/repo' })
    hook('s-cwd', { id: 'outer', state: 'done', cwd: '/repo-wt-feature' })
    hook('s-cwd', { id: 'inner', state: 'done', cwd: '/elsewhere' })
    expect(new SessionLedger().get('s-cwd')?.workdir).toBe('/repo-wt-feature')
  })

  it('accepts only the cockpit id from a provider that adopts it', () => {
    const { ledger, turns, hook } = setup(true)
    ledger.recordSpawn('s-adopt', null, 'p1', 'claude')
    hook('s-adopt', { id: 'someone-else', state: 'done' })
    expect(turns.get('s-adopt')).toBeUndefined()
    hook('s-adopt', { id: 's-adopt', state: 'done' })
    expect(turns.get('s-adopt')?.state).toBe('done')
    expect(ledger.get('s-adopt')?.providerSessionId).toBe('s-adopt')
  })

  it('takes the payload id as the cockpit id when a hook names no session', () => {
    const { turns, hook } = setup(true)
    hook(null, { id: 's-unnamed', state: 'waiting' })
    expect(turns.get('s-unnamed')?.state).toBe('waiting')
  })

  it('holds a state that may settle by itself, and drops it when the session moves on', async () => {
    const { TurnTracker: Tracker } = await import('../src/turn-state.js')
    const turns = new Tracker()
    const seen: string[] = []
    turns.on('turn', (event: { state: string }) => seen.push(event.state))
    turns.apply({ sessionId: 's', state: 'working' })
    turns.apply({ sessionId: 's', state: 'waiting', settleMs: 30 })
    expect(turns.get('s')?.state).toBe('working')
    turns.apply({ sessionId: 's', state: 'working' })
    await new Promise((r) => setTimeout(r, 60))
    expect(seen).toEqual(['working', 'working'])

    turns.apply({ sessionId: 's', state: 'waiting', settleMs: 30 })
    await new Promise((r) => setTimeout(r, 60))
    expect(turns.get('s')?.state).toBe('waiting')
    expect(seen).toEqual(['working', 'working', 'waiting'])
  })

  it('leaves a session\'s mark and the archive to its chat: a hook moves only the turn state, in a terminal too', () => {
    const { ledger, turns, hook } = setup(false)
    for (const id of ['s-term', 's-chat']) {
      ledger.recordSpawn(id, null, 'p1', 'claude')
      ledger.archive(id)
      ledger.setAttention(id, { kind: 'done', reason: 'Rescheduled' })
    }
    ledger.setRuntime('s-chat', 'sdk')
    hook('s-term', { id: 'term-id', state: 'working', prompt: true })
    hook('s-chat', { id: 'chat-id', state: 'working', prompt: true })
    for (const id of ['s-term', 's-chat']) {
      expect(turns.get(id)?.state).toBe('working')
      expect(ledger.get(id)?.attention?.kind).toBe('done')
      expect(ledger.get(id)?.archivedAt).not.toBeNull()
    }
  })

  it('a turn that ends with a question ends as done; only a live prompt is waiting', () => {
    const { ledger, turns, hook } = setup(false)
    ledger.recordSpawn('s-ask', null, 'p1', 'claude')
    ledger.setAttention('s-ask', { kind: 'question', reason: 'A or B?' })
    hook('s-ask', { id: 'ask-id', state: 'done' })
    expect(turns.get('s-ask')?.state).toBe('done')
    expect(ledger.get('s-ask')?.attention?.kind).toBe('question')
    hook('s-ask', { id: 'ask-id', state: 'waiting' })
    expect(turns.get('s-ask')?.state).toBe('waiting')
  })

  it('a terminal fallback session\'s done records no result: it has no turn routing', () => {
    const { ledger, hook } = setup(false)
    ledger.recordSpawn('s-term', null, 'p1', 'claude')
    hook('s-term', { id: 'term-id', state: 'working' })
    hook('s-term', { id: 'term-id', state: 'done' })
    expect(ledger.get('s-term')?.resultAt).toBeNull()
  })


  it('holds a done back while the session waits on its helpers, and applies any other signal', () => {
    const { ledger, providers, turns } = setup(false)
    ledger.recordSpawn('s-helpers', null, 'p1', 'claude', true)
    ledger.setRuntime('s-helpers', 'sdk')
    let waits = true
    const asked: string[] = []
    const hook = (payload: Record<string, unknown>) => applySessionHook(
      { ledger, providers, turns, waitsOnHelpers: (sessionId) => { asked.push(sessionId); return waits } }, 's-helpers', payload,
    )
    hook({ id: 'c1', state: 'working' })
    expect(ledger.get('s-helpers')?.turnInFlight).toBeTruthy()
    hook({ id: 'c1', state: 'done' })
    expect(turns.get('s-helpers')?.state).toBe('working')
    // The turn itself is over all the same: nothing is cut off should the host go down.
    expect(ledger.get('s-helpers')?.turnInFlight).toBeFalsy()
    hook({ id: 'c1', state: 'waiting' })
    expect(turns.get('s-helpers')?.state).toBe('waiting')
    hook({ id: 'c1', state: 'working' })
    // Only a done asks: a question or the helpers being back make it false (chat-bridge.ts waitsOnHelpers).
    expect(asked).toEqual(['s-helpers'])
    waits = false
    hook({ id: 'c1', state: 'done' })
    expect(turns.get('s-helpers')?.state).toBe('done')
  })

  it('leaves the turn state of a session whose chat reports its turns to the chat, and still binds its conversation and folder', () => {
    const { ledger, providers, turns } = setup(false)
    ledger.recordSpawn('s-reports-turns', null, 'p1', 'claude', true)
    ledger.setRuntime('s-reports-turns', 'sdk')
    const hook = (payload: Record<string, unknown>) => applySessionHook({ ledger, providers, turns, reportsTurns: (id) => id === 's-reports-turns' }, 's-reports-turns', payload)
    hook({ id: 'thread-1', state: 'working', cwd: '/work/tree' })
    hook({ id: 'thread-1', state: 'done' })
    expect(turns.get('s-reports-turns')).toBeUndefined()
    expect(ledger.get('s-reports-turns')).toMatchObject({ providerSessionId: 'thread-1', workdir: '/work/tree' })
    expect(ledger.get('s-reports-turns')?.turnInFlight).toBeFalsy()
  })

  it('says how many subagents a working session waits for, until its state changes', () => {
    const turns = new TurnTracker()
    const events: Array<{ state: string; since: string; helpers?: number }> = []
    turns.on('turn', (event) => events.push(event))
    turns.waitOn('s-wait', 2)
    expect(turns.get('s-wait')).toBeUndefined()
    turns.apply({ sessionId: 's-wait', state: 'working' })
    const since = turns.get('s-wait')!.since
    turns.waitOn('s-wait', 2)
    turns.waitOn('s-wait', 2)
    expect(turns.get('s-wait')).toEqual({ state: 'working', since, helpers: 2 })
    expect(turns.snapshot()).toEqual([{ sessionId: 's-wait', state: 'working', since, helpers: 2 }])
    turns.waitOn('s-wait', 0)
    expect(turns.get('s-wait')).toEqual({ state: 'working', since })
    expect(events.map((e) => e.helpers ?? 0)).toEqual([0, 2, 0])
    turns.waitOn('s-wait', 1)
    turns.apply({ sessionId: 's-wait', state: 'done' })
    expect(turns.get('s-wait')?.helpers).toBeUndefined()
    turns.waitOn('s-wait', 1)
    expect(turns.get('s-wait')?.helpers).toBeUndefined()
  })

  it('passes hooks without a turn state on as notes', () => {
    const { turns, hook } = setup(true)
    const notes: string[] = []
    turns.on('notification', (label: string) => notes.push(label))
    hook('legacy', { label: 'idle_prompt' })
    hook('legacy', {})
    expect(notes).toEqual(['idle_prompt'])
  })
})
