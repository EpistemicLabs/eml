import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentProvider } from '../src/domain/agent-provider.js'
import type { BrainSpace } from '../src/brain-space.js'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-spawn-inbox-test-'))
process.env.EML_COCKPIT_HOME = home
const inbox = join(home, 'spawn-inbox')
const TOKEN = 'spawn-token-of-this-boot'

describe('spawn inbox', () => {
  let spawns: import('../src/spawn-queue.js').SpawnQueue
  let folder: string

  beforeAll(async () => {
    const { SpawnQueue } = await import('../src/spawn-queue.js')
    const { ProjectRegistry } = await import('../src/project-registry.js')
    const { ProviderRegistry } = await import('../src/infrastructure/providers/registry.js')
    const { BrainSpaces } = await import('../src/brain-space.js')
    const { SessionLedger } = await import('../src/session-ledger.js')
    const { watchSpawnInbox } = await import('../src/spawn-inbox.js')
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-spawn-inbox-project-')))
    const projects = new ProjectRegistry()
    projects.create(folder, 'A project')
    spawns = new SpawnQueue()
    // A leftover of an earlier boot must not be acted on.
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, `${randomUUID()}.json`), JSON.stringify({ project: folder, prompt: 'stale', token: TOKEN }))
    // The main space, as far as a worker request looks at it: its registry and brain project list.
    const main = { id: 'main', main: true, ledgerKey: null, registry: projects, projects: { list: async () => [] } } as unknown as BrainSpace
    watchSpawnInbox({
      spawns, spawnToken: TOKEN,
      spaces: new BrainSpaces(main),
      ledger: new SessionLedger(),
      providers: new ProviderRegistry({ providers: [{ id: 'claude', messaging: true } as AgentProvider, { id: 'codex', messaging: false } as AgentProvider] }),
    })
  })
  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(folder, { recursive: true, force: true })
  })

  const request = async (body: Record<string, unknown>) => {
    const id = randomUUID()
    writeFileSync(join(inbox, `${id}.json.tmp`), JSON.stringify(body))
    const { renameSync } = await import('node:fs')
    renameSync(join(inbox, `${id}.json.tmp`), join(inbox, `${id}.json`))
    const result = join(inbox, `${id}.result.json`)
    for (let i = 0; i < 100 && !existsSync(result); i++) await new Promise((r) => setTimeout(r, 50))
    return { id, outcome: JSON.parse(readFileSync(result, 'utf8')) as { status: number; payload: Record<string, any> } }
  }

  it('drops requests left from an earlier boot', () => {
    expect(spawns.list()).toEqual([])
  })

  it('queues a request that carries the spawn token, removes the file and answers', async () => {
    const { id, outcome } = await request({ project: folder, prompt: 'Do the thing', title: 'Worker', provider: 'codex', fromSession: 's-1', token: TOKEN })
    expect(outcome.status).toBe(202)
    expect(existsSync(join(inbox, `${id}.json`))).toBe(false)
    expect(spawns.list()).toMatchObject([{ prompt: 'Do the thing', title: 'Worker', provider: 'codex', fromSessionId: 's-1', projectId: outcome.payload.projectId }])
    // A codex worker cannot be messaged — no address.
    expect(outcome.payload).not.toHaveProperty('address')
  })

  it('answers with the address of a worker that can be messaged, derived from the request id', async () => {
    const { outcome } = await request({ project: folder, prompt: 'Ask me back', provider: 'claude', token: TOKEN })
    expect(outcome.status).toBe(202)
    expect(outcome.payload.address).toBe(`session-${outcome.payload.id.replace(/-/g, '').slice(0, 8)}`)
  })

  it('refuses a request without the token, and says why a request is wrong', async () => {
    const before = spawns.list().length
    expect((await request({ project: folder, prompt: 'x', token: 'guess' })).outcome.status).toBe(403)
    const unknown = (await request({ project: '/nowhere', prompt: 'x', token: TOKEN })).outcome
    expect(unknown.status).toBe(404)
    expect(unknown.payload.error.message).toContain(folder)
    expect((await request({ project: folder, prompt: 'x', provider: 'nope', token: TOKEN })).outcome.payload.error.code).toBe('UNKNOWN_PROVIDER')
    expect(spawns.list().length).toBe(before)
  })
})
