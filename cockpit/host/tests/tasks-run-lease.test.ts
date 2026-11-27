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
// session gets the run's prompt there, a session still starting on it refuses the run, naming it.

const ORIGIN = 'http://cockpit.test'

describe('a task run without a desk', () => {
  let server: Server
  let base: string
  let ledger: import('../src/session-ledger.js').SessionLedger
  let spawns: import('../src/spawn-queue.js').SpawnQueue
  const delivered: Array<{ target: string; text: string }> = []
  let outcome = 'delivered'

  beforeAll(async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const { SpawnQueue } = await import('../src/spawn-queue.js')
    const { BrainSpaces } = await import('../src/brain-space.js')
    const { TurnTracker } = await import('../src/turn-state.js')
    const { createHostServer } = await import('../src/http.js')
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
    }
    server = createHostServer(deps as never, [ORIGIN])
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(home, { recursive: true, force: true })
  })
  beforeEach(() => { delivered.length = 0; outcome = 'delivered' })

  const run = async (taskId: string, prompt = 'Advance it') => {
    const res = await fetch(`${base}/api/tasks/run`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ projectId: 'bp-eml', prompt, title: 'Task', taskId }),
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

  it('refuses when the holding session cannot take it, saying whether a retry helps', async () => {
    ledger.recordSpawn('busy-session', null, 'bp-eml', 'claude', false, 'busy-task')
    outcome = 'busy'
    const out = await run('busy-task')
    expect(out.status).toBe(409)
    expect(out.body.error).toMatchObject({ code: 'TASK_HELD', retry: true })
    expect(spawns.list().some((r) => r.taskId === 'busy-task')).toBe(false)
  })
})
