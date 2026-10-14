import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider } from '../src/domain/agent-provider.js'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-provider-default-test-'))
process.env.EML_COCKPIT_HOME = home

/** A provider that can start sessions, or one whose runtime reports `problem`. */
const stub = (id: string, problem: string | null = null) =>
  ({ id, runtime: { problem: () => problem } } as unknown as AgentProvider)

describe('default provider', () => {
  let settings: typeof import('../src/provider-settings.js')
  let ProviderRegistry: typeof import('../src/infrastructure/providers/registry.js')['ProviderRegistry']

  beforeAll(async () => {
    settings = await import('../src/provider-settings.js');
    ({ ProviderRegistry } = await import('../src/infrastructure/providers/registry.js'))
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('is the first registered provider until the user chooses, then follows the setting', () => {
    const registry = new ProviderRegistry({ preferred: settings.readDefaultProvider, providers: [stub('claude'), stub('codex')] })
    expect(registry.default().id).toBe('claude')
    settings.writeDefaultProvider('codex')
    expect(registry.default().id).toBe('codex')
  })

  it('keeps the other agent settings in the file and ignores an unknown choice', () => {
    writeFileSync(join(home, 'agents.json'), JSON.stringify({ permissionMode: 'bypassPermissions', defaultProvider: 'nope' }))
    expect(settings.readDefaultProvider()).toBeUndefined()
    settings.writeDefaultProvider('claude')
    expect(JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8'))).toEqual({ permissionMode: 'bypassPermissions', defaultProvider: 'claude' })
  })

  it('falls back to a provider that can start sessions when the chosen one cannot', () => {
    const broken = stub('codex', 'Codex for the cockpit is not set up yet.')
    const registry = new ProviderRegistry({ preferred: () => 'codex', providers: [stub('claude'), broken] })
    expect(registry.default().id).toBe('claude')
    // Nothing works: the choice stands, and its problem is what the user sees.
    const none = new ProviderRegistry({ preferred: () => 'codex', providers: [stub('claude', 'damaged'), broken] })
    expect(none.default().id).toBe('codex')
  })

  it('gives a session its recorded provider, whatever the default is', () => {
    const registry = new ProviderRegistry({
      providerOf: (sessionId) => (sessionId === 'old' ? 'claude' : undefined),
      preferred: () => 'codex',
      providers: [stub('claude'), stub('codex')],
    })
    expect(registry.forSession('old').id).toBe('claude')
    expect(registry.forSession('new').id).toBe('codex')
    expect(registry.get('nope')).toBeUndefined()
  })
})
