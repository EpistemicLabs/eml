import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A home's brains (provision.ts, agents.ts): the first agent's brain seeded
// with its identity, the main space with the objects only, the config naming
// the human, the agent and both tokens; a further space bound to the agent;
// the agent brains loaded back from the config against control.db.

const home = mkdtempSync(join(tmpdir(), 'cockpit-provision-test-'))
process.env.EML_COCKPIT_HOME = home
const require = createRequire(import.meta.url)
const core = require('@engramprotocol/core')
const Database = require('better-sqlite3')

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('provisioning a home', () => {
  it('seeds the identity into the agent brain, the spaces get the objects only, every token under the handle', async () => {
    const { provisionBrain, provisionSpace } = await import('../src/provision.js')
    const { loadAgentBrains } = await import('../src/agents.js')
    const { readCockpitConfig } = await import('../src/config.js')
    const { DATA_DIR } = await import('../src/paths.js')
    const main = await provisionBrain({ userId: 'alex', userName: 'Alex Doe', agentId: 'juno', agentName: 'Juno' }, core)
    expect(main).toMatchObject({ reused: false, onboarding: 'pending' })

    const config = await readCockpitConfig()
    expect(config).toMatchObject({ token: main.token, onboarding: 'pending', handle: 'alex', agent: 'juno' })
    expect(config?.agents).toHaveLength(1)
    expect(config?.agents?.[0].id).toBe('juno')
    expect(config?.agents?.[0].token).not.toBe(main.token)

    const life = await provisionSpace('Life', { id: 'juno', name: 'Juno' }, { handle: 'alex', name: 'Alex Doe' }, core)
    expect((await readCockpitConfig())?.spaces).toEqual([{ token: life.token, name: 'Life', agent: 'juno' }])

    const control = new Database(join(DATA_DIR, 'control.db'), { readonly: true })
    const brains = control.prepare(
      'SELECT b.id, b.name, b.brain_file, t.name AS token_name FROM brains b JOIN tokens t ON t.brain_id = b.id ORDER BY b.created_at, b.rowid',
    ).all() as Array<{ id: string; name: string; brain_file: string; token_name: string }>
    control.close()
    expect(brains.map((b) => [b.name, b.token_name])).toEqual([['juno', 'alex'], ['Main', 'alex'], ['Life', 'alex']])
    expect(brains[1].id).toBe(main.brainId)
    expect(brains[2].id).toBe(life.brainId)

    const count = (file: string) => {
      const db = new Database(join(DATA_DIR, file), { readonly: true })
      try {
        return {
          engrams: (db.prepare('SELECT COUNT(*) AS n FROM engrams').get() as { n: number }).n,
          agents: (db.prepare('SELECT id FROM agents').all() as Array<{ id: string }>).map((a) => a.id),
          users: (db.prepare('SELECT id FROM users').all() as Array<{ id: string }>).map((u) => u.id),
        }
      } finally {
        db.close()
      }
    }
    expect(count(brains[0].brain_file)).toEqual({ engrams: 5, agents: ['juno'], users: ['alex'] })
    expect(count(brains[1].brain_file)).toEqual({ engrams: 0, agents: ['juno'], users: ['alex'] })
    expect(count(brains[2].brain_file)).toEqual({ engrams: 0, agents: ['juno'], users: ['alex'] })

    // Loaded back: the agent brain by its token, checked against the brain's name.
    const lines: string[] = []
    const agents = loadAgentBrains(await readCockpitConfig(), 'http://127.0.0.1:1', (l) => lines.push(l))
    expect(agents.list()).toEqual([{ id: 'juno', brainId: brains[0].id, url: 'http://127.0.0.1:1', token: config?.agents?.[0].token }])
    expect(lines).toEqual([])
    const wrong = loadAgentBrains({ token: 't', agents: [{ id: 'juno', token: main.token }, { id: 'ghost', token: 'eml_nope' }] }, 'http://127.0.0.1:1', (l) => lines.push(l))
    expect(wrong.list()).toEqual([])
    expect(lines).toEqual(['agent juno: its token belongs to brain "Main" — skipped', 'agent ghost: the configured token matches no brain — skipped'])
  })
})
