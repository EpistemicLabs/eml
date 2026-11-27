import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-tasks-run-lease-test-'))
process.env.EML_COCKPIT_HOME = home

// A task run from the page without a desk (POST /api/tasks/run) keeps to one live session per task: a task with its
// session gets the run's prompt there, a session still starting on it refuses the run, naming it. A holder whose
// context is very long is put away and the run starts in its place. A queued runner request that went stale is
// revoked when a tab claims it (spawn-api.ts).

const ORIGIN = 'http://cockpit.test'

describe('a task run without a desk', () => {
  let server: Server
  let base: string
  let ledger: import('../src/session-ledger.js').SessionLedger
  let spawns: import('../src/spawn-queue.js').SpawnQueue
  const delivered: Array<{ target: string; text: string }> = []
  let outcome = 'delivered'
  const contextTokens = new Map<string, number>()
  const putAway: string[] = []
  const staleRequests = new Map<string, string>()

  beforeAll(async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const { SpawnQueue } = await import('../src/spawn-queue.js')
    const { BrainSpaces } = await import('../src/brain-space.js')
    const { TurnTracker } = await import('../src/turn-state.js')
    const { createHostServer } = await import('../src/http.js')
    const { createRecentOperations, RECENT_OPERATIONS } = await import('../src/application/recent-operations.js')
    ledger = new SessionLedger()
    spawns = new SpawnQueue()
    const space = {
      id: 'main', name: 'Main', main: true, agent: null, runtime: null, ledgerKey: null, url: 'http://127.0.0.1:1', token: 'x',
      registry: { get: (projectId: string) => ({ projectId, path: `/projects/${projectId}` }) }, notes: { subscribe: () => () => {} },
    }
    const deps = {
      spaces: new BrainSpaces(space as never),
      turns: new TurnTracker(),
      providers: { forSession: () => ({ id: 'claude' }), all: () => [] },
      bridge: { ledger },
      chat: {},
      spawns,
      spawnToken: 'spawn-token',
      hookToken: 'hook-token',
      turnHookConfig: '',
      deliver: async (request: { target: string; text: string }) => { delivered.push(request); return outcome },
      runOperations: createRecentOperations({ ...RECENT_OPERATIONS, now: () => Date.now() }),
      taskLease: {
        contextTokensOf: (sessionId: string) => contextTokens.get(sessionId) ?? null,
        putAway: async (sessionId: string) => { putAway.push(sessionId); ledger.archive(sessionId); return null },
        stale: (request: { id: string }) => staleRequests.get(request.id) ?? null,
      },
    }
    server = createHostServer(deps as never, [ORIGIN])
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(home, { recursive: true, force: true })
  })
  beforeEach(() => { delivered.length = 0; outcome = 'delivered'; putAway.length = 0 })

  const run = async (taskId: string, prompt = 'Advance it', opId?: string) => {
    const res = await fetch(`${base}/api/tasks/run`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ projectId: 'bp-eml', prompt, title: 'Task', taskId, ...(opId ? { opId } : {}) }),
    })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  it('queues one run, and refuses a second while the first is starting, naming it', async () => {
    const first = await run('free-task')
    expect(first.status).toBe(202)
    const second = await run('free-task', 'Advance it again')
    expect(second.status).toBe(409)
    expect(second.body.error).toMatchObject({ code: 'TASK_STARTING', retry: true })
    expect(String((second.body.error as { message: string }).message)).toContain(String(first.body.id))
    expect(spawns.list().filter((r) => r.taskId === 'free-task')).toHaveLength(1)
  })

  it('gives the run\'s prompt to the session that holds the task, and starts none', async () => {
    ledger.recordSpawn('task-session', null, 'bp-eml', 'claude', false, 'held-task')
    const out = await run('held-task')
    expect(out).toEqual({ status: 200, body: { id: 'task-session', routed: true } })
    expect(delivered).toEqual([expect.objectContaining({ target: 'task-session', text: 'Advance it' })])
    expect(spawns.list().some((r) => r.taskId === 'held-task')).toBe(false)
  })

  it('gives the prompt once for one Start, however often the page sends it', async () => {
    ledger.recordSpawn('again-session', null, 'bp-eml', 'claude', false, 'again-task')
    const opId = '3c9d2a1e-5b7f-4c8d-9e0a-1b2c3d4e5f60'
    const first = await run('again-task', 'Advance it', opId)
    const again = await run('again-task', 'Advance it', opId)
    expect(again).toEqual(first)
    expect(first).toEqual({ status: 200, body: { id: 'again-session', routed: true } })
    expect(delivered).toHaveLength(1)
    await run('again-task', 'Advance it', '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d')
    expect(delivered).toHaveLength(2)
  })

  it('refuses when the holding session cannot take it, saying whether a retry helps', async () => {
    ledger.recordSpawn('busy-session', null, 'bp-eml', 'claude', false, 'busy-task')
    outcome = 'busy'
    const out = await run('busy-task')
    expect(out.status).toBe(409)
    expect(out.body.error).toMatchObject({ code: 'TASK_HELD', retry: true })
    expect(spawns.list().some((r) => r.taskId === 'busy-task')).toBe(false)
  })

  it('puts away a holder whose context is very long and queues the run in its place', async () => {
    const { LONG_CONTEXT_TOKENS } = await import('../src/domain/own-session.js')
    ledger.recordSpawn('long-session', null, 'bp-eml', 'claude', false, 'long-task')
    contextTokens.set('long-session', LONG_CONTEXT_TOKENS)
    const out = await run('long-task')
    expect(out.status).toBe(202)
    expect(putAway).toEqual(['long-session'])
    expect(delivered).toEqual([])
    expect(spawns.list().filter((r) => r.taskId === 'long-task')).toHaveLength(1)
  })

  it('revokes a stale runner request a tab claims, and hands nothing out', async () => {
    const request = spawns.add({ projectId: 'bp-eml', prompt: 'Step', title: 'Step', fromSessionId: null, origin: 'runner', taskId: 'stale-task' })
    staleRequests.set(request.id, 'the owner works on the task now')
    const res = await fetch(`${base}/api/spawns/${request.id}/claim`, { method: 'POST', headers: { origin: ORIGIN } })
    expect(res.status).toBe(409)
    expect((await res.json() as { error: unknown }).error).toMatchObject({ code: 'REVOKED', retry: false })
    expect(spawns.list().some((r) => r.id === request.id)).toBe(false)
  })
})
