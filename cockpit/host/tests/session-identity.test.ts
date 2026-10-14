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
  runtime: { problem: () => null },
  turnSignal: (payload): TurnSignal | null =>
    typeof payload.id === 'string'
      ? { kind: 'turn', providerSessionId: payload.id, state: payload.state as 'working' | 'done' | 'waiting' }
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
    expect(ledger.ref('legacy', '/some/path')).toEqual({ sessionId: 'legacy', providerSessionId: null, projectPath: '/some/path' })
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

  it('passes hooks without a turn state on as notes', () => {
    const { turns, hook } = setup(true)
    const notes: string[] = []
    turns.on('notification', (label: string) => notes.push(label))
    hook('legacy', { label: 'idle_prompt' })
    hook('legacy', {})
    expect(notes).toEqual(['idle_prompt'])
  })
})
