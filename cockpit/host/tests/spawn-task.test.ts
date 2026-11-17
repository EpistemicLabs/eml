import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-spawn-task-'))
process.env.EML_COCKPIT_HOME = home

// Task system: a worker works on the task it is given (--task), on a new step
// of its requester's task (--step), or on a task of its own.

describe('spawning a worker with a task', () => {
  let mods: {
    requestSpawn: typeof import('../src/spawn-api.js')['requestSpawn']
    SessionLedger: typeof import('../src/session-ledger.js')['SessionLedger']
    SpawnQueue: typeof import('../src/spawn-queue.js')['SpawnQueue']
  }
  beforeAll(async () => {
    mods = {
      requestSpawn: (await import('../src/spawn-api.js')).requestSpawn,
      SessionLedger: (await import('../src/session-ledger.js')).SessionLedger,
      SpawnQueue: (await import('../src/spawn-queue.js')).SpawnQueue,
    }
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const setup = () => {
    const ledger = new mods.SessionLedger()
    const spawns = new mods.SpawnQueue()
    const space = { main: true, id: 'main', registry: { get: () => ({ projectId: 'bp-eml' }), list: () => [] }, projects: { list: async () => [] } }
    const provider = { id: 'claude', messaging: true, workerRunsInChat: () => true }
    const deps = {
      ledger, spawns, spawnToken: 't', deliver: async () => 'delivered' as const,
      spaces: { resolve: () => space }, providers: { get: () => undefined, default: () => provider, all: () => [provider] },
    } as unknown as Parameters<typeof mods.requestSpawn>[0]
    ledger.recordSpawn('lord', null, 'bp-eml', 'claude', false, 'inbox-task')
    return { ledger, spawns, deps }
  }

  it('carries the task it is given', async () => {
    const { spawns, deps } = setup()
    const out = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'reply to Lohmann', fromSession: 'lord', task: 'lohmann-task' })
    expect(out.status).toBe(202)
    expect(spawns.list()[0].taskId).toBe('lohmann-task')
  })

  it('makes its task a step of the requester\'s only with step, and refuses step without a task or with task', async () => {
    const { ledger, spawns, deps } = setup()
    const out = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'part of it', fromSession: 'lord', step: true })
    const id = (out.payload as { id: string }).id
    expect(ledger.expectedTaskParent(id)).toBe('inbox-task')
    expect(spawns.list()[0].taskId).toBeUndefined()

    const own = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'own', fromSession: 'lord' })
    expect(ledger.expectedTaskParent((own.payload as { id: string }).id)).toBeNull()

    ledger.recordSpawn('plain', null, 'bp-eml', 'claude')
    expect((await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'x', fromSession: 'plain', step: true })).status).toBe(400)
    expect((await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'x', fromSession: 'lord', step: true, task: 't' })).status).toBe(400)
  })
})
