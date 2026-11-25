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
    const space = { main: true, id: 'main', registry: { get: (id: string) => (id.startsWith('bp-') || id === 'notes-folder' ? { projectId: id } : undefined), list: () => [] }, projects: { list: async () => [{ id: 'lohmann', name: 'Lohmann' }] } }
    const created: Array<{ title: string; content: string; scope: string }> = []
    const provider = { id: 'claude', messaging: true, workerRunsInChat: () => true }
    const deps = {
      ledger, spawns, spawnToken: 't', deliver: async () => 'delivered' as const,
      spaces: { resolve: () => space }, providers: { get: () => undefined, default: () => provider, all: () => [provider] },
      createTask: async (_space: unknown, input: { title: string; content: string; scope: string }) => { created.push(input); return { id: 'new-task' } },
    } as unknown as Parameters<typeof mods.requestSpawn>[0]
    ledger.recordSpawn('lord', null, 'bp-eml', 'claude', false, 'inbox-task')
    return { ledger, spawns, deps, created }
  }

  it('carries the task it is given', async () => {
    const { spawns, deps } = setup()
    const out = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'reply to Lohmann', fromSession: 'lord', task: 'lohmann-task' })
    expect(out.status).toBe(202)
    expect(spawns.list()[0].taskId).toBe('lohmann-task')
  })

  it('creates a new task in the named project and puts the worker on it', async () => {
    const { ledger, spawns, deps, created } = setup()
    ledger.setAgentTitle('lord', 'Email Lord')
    const out = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'reply', fromSession: 'lord', newTask: { title: 'Lohmann custom tracking', in: 'Lohmann', text: 'Answer the custom tracking request.' } })
    expect(out.status).toBe(202)
    expect((out.payload as { taskId?: string }).taskId).toBe('new-task')
    expect(created).toEqual([{ title: 'Lohmann custom tracking', content: 'Answer the custom tracking request. Started by session Email Lord.', scope: 'project.lohmann', fromTaskId: 'inbox-task' }])
    expect(spawns.list()[0].taskId).toBe('new-task')
    // Without --in the worker's project; one of task, step and newTask only.
    await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'x', fromSession: 'lord', newTask: { title: 'Other' } })
    expect(created.at(-1)!.scope).toBe('project.eml')
    expect((await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'x', fromSession: 'lord', newTask: { title: 'A' }, task: 't' })).status).toBe(400)
    expect((await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'x', fromSession: 'lord', newTask: { title: '' } })).status).toBe(400)
    // A folder-only project has no project of the brain for the task: refused, nothing made
    const before = created.length
    const folder = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'x', fromSession: 'lord', newTask: { title: 'Notes', in: 'notes-folder' } })
    expect(folder.status).toBe(400)
    expect((folder.payload as { error: { code: string } }).error.code).toBe('NEW_TASK_NEEDS_PROJECT')
    expect(created).toHaveLength(before)
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
