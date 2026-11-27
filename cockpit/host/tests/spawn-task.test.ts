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
    handleSpawnApi: typeof import('../src/spawn-api.js')['handleSpawnApi']
    SessionLedger: typeof import('../src/session-ledger.js')['SessionLedger']
    SpawnQueue: typeof import('../src/spawn-queue.js')['SpawnQueue']
  }
  beforeAll(async () => {
    mods = {
      requestSpawn: (await import('../src/spawn-api.js')).requestSpawn,
      handleSpawnApi: (await import('../src/spawn-api.js')).handleSpawnApi,
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
    const provider = { id: 'claude', capabilities: { messaging: { supported: true } }, workerRunsInChat: () => true }
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

  describe('on a task that already has its session (one live session per task)', () => {
    const held = (extra: Record<string, unknown> = {}) => {
      const { ledger, spawns, deps } = setup()
      const delivered: Array<Record<string, unknown>> = []
      const putAway: string[] = []
      let outcome = 'delivered'
      let tokens: number | null = 20_000
      const provider = { id: 'claude', capabilities: { messaging: { supported: true } }, workerRunsInChat: () => true }
      Object.assign(deps, {
        providers: { get: () => undefined, default: () => provider, all: () => [provider], forSession: () => provider },
        deliver: async (request: Record<string, unknown>) => { delivered.push(request); return outcome },
        contextTokensOf: () => tokens,
        putAway: async (id: string) => { putAway.push(id); ledger.archive(id); return null },
        ...extra,
      })
      ledger.recordSpawn('task-session', null, 'bp-eml', 'claude', false, 'held-task')
      ledger.setAgentTitle('task-session', 'Customer reply')
      return { ledger, spawns, deps, delivered, putAway, setOutcome: (o: string) => { outcome = o }, setTokens: (t: number | null) => { tokens = t } }
    }

    it('gives the prompt to that session instead of starting a worker, and answers with its id and address', async () => {
      const { spawns, deps, delivered } = held()
      const out = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'add the tracking link', fromSession: 'lord', task: 'held-task' })
      expect(out.status).toBe(200)
      expect(out.payload).toMatchObject({ id: 'task-session', projectId: 'bp-eml', queued: false, routed: true, taskId: 'held-task' })
      expect((out.payload as { address?: string }).address).toBeTruthy()
      expect(spawns.list()).toEqual([])
      expect(delivered).toEqual([expect.objectContaining({ target: 'task-session', text: 'add the tracking link', caller: 'session' })])
      expect(String(delivered[0].from)).toContain('lord')
    })

    it('gives the prompt once for one operation id, however often it arrives (a CLI retry, the inbox after HTTP)', async () => {
      const { createRecentOperations, RECENT_OPERATIONS } = await import('../src/application/recent-operations.js')
      const { spawns, deps, delivered } = held({ operations: createRecentOperations({ ...RECENT_OPERATIONS, now: () => Date.now() }) })
      const body = { project: 'bp-eml', prompt: 'add the tracking link', fromSession: 'lord', task: 'held-task', opId: '7f0c2f4e-8d0b-4f7e-9a51-0d8c3a1b2c3d' }
      const first = await mods.requestSpawn(deps, body)
      const again = await mods.requestSpawn(deps, { ...body })
      expect(again).toEqual(first)
      expect(delivered).toHaveLength(1)
      // Another operation, or none, is a new start.
      await mods.requestSpawn(deps, { ...body, opId: '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9' })
      await mods.requestSpawn(deps, { ...body, opId: undefined })
      expect(delivered).toHaveLength(3)
      expect(spawns.list()).toEqual([])
    })

    it('refuses, naming the session, when that session cannot take the message', async () => {
      for (const outcome of ['busy', 'refused']) {
        const { spawns, deps, setOutcome } = held()
        setOutcome(outcome)
        const out = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'x', fromSession: 'lord', task: 'held-task' })
        expect(out.status).toBe(409)
        const error = (out.payload as { error: { code: string; message: string; retry: boolean } }).error
        expect(error.code).toBe('TASK_HELD')
        expect(error.retry).toBe(outcome === 'busy')
        expect(error.message).toContain('Customer reply')
        expect(spawns.list()).toEqual([])
      }
    })

    it('refuses while a session is starting on the task, and when the requester holds it itself', async () => {
      const { ledger, spawns, deps } = held()
      spawns.add({ projectId: 'bp-eml', prompt: 'step', title: null, fromSessionId: null, origin: 'runner', taskId: 'starting-task' })
      const starting = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'x', fromSession: 'lord', task: 'starting-task' })
      expect((starting.payload as { error: unknown }).error).toMatchObject({ code: 'TASK_STARTING', retry: true })
      ledger.setTask('lord', 'own-task')
      const own = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'x', fromSession: 'lord', task: 'own-task' })
      expect((own.payload as { error: unknown }).error).toMatchObject({ code: 'TASK_HELD_BY_YOU', retry: false })
      expect(spawns.list()).toHaveLength(1)
    })

    it('puts a holder with a very long context away and starts the worker in its place', async () => {
      const { spawns, deps, delivered, putAway, setTokens } = held()
      setTokens(200_000)
      const out = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'fresh start', fromSession: 'lord', task: 'held-task' })
      expect(out.status).toBe(202)
      expect(putAway).toEqual(['task-session'])
      expect(delivered).toEqual([])
      expect(spawns.list().map((r) => r.taskId)).toEqual(['held-task'])
    })

    it('puts the newest holder away and starts the worker, also when an older session is still open on the task', async () => {
      const { ledger, spawns, deps, putAway, setTokens } = held()
      ledger.recordSpawn('older-session', null, 'bp-eml', 'claude', false, 'two-sessions')
      // The newer one holds the task.
      await new Promise((resolve) => setTimeout(resolve, 5))
      ledger.recordSpawn('newer-session', null, 'bp-eml', 'claude', false, 'two-sessions')
      setTokens(200_000)
      const out = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'fresh start', fromSession: 'lord', task: 'two-sessions' })
      expect(out.status).toBe(202)
      expect(putAway).toEqual(['newer-session'])
      expect(spawns.list().map((r) => r.taskId)).toEqual(['two-sessions'])
    })

    it('a scheduled run on the task does not hold it: the worker starts', async () => {
      const { ledger, spawns, deps, delivered } = held()
      ledger.recordSpawn('job-run', null, 'bp-eml', 'claude', true, 'job-task')
      ledger.setJobId('job-run', 'job-task')
      const out = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'x', fromSession: 'lord', task: 'job-task' })
      expect(out.status).toBe(202)
      expect(delivered).toEqual([])
      expect(spawns.list()).toHaveLength(1)
    })

    it('a tab\'s claim of a runner request that went stale gets it revoked, not started', async () => {
      const { spawns, deps } = held()
      const runner = spawns.add({ projectId: 'bp-eml', prompt: 'step', title: null, fromSessionId: null, origin: 'runner', taskId: 'claimed-task' })
      const answers: Array<[number, unknown]> = []
      const started: string[] = []
      const handled = await mods.handleSpawnApi(
        { headers: {} } as never, {} as never,
        { ...deps, stale: () => 'the owner works on the task now', outsideToken: 'o', workers: { hasRoom: () => true, forPane: (r: { id: string }) => { started.push(r.id); return 'sdk' } } } as never,
        `/api/spawns/${runner.id}/claim`, 'POST', (_res, status, payload) => answers.push([status, payload]), async () => ({}),
      )
      expect(handled).toBe(true)
      expect(answers[0][0]).toBe(409)
      expect((answers[0][1] as { error: { code: string } }).error.code).toBe('REVOKED')
      expect(started).toEqual([])
      expect(spawns.list()).toEqual([])
    })
  })
})
