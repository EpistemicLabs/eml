import { describe, it, expect, beforeEach } from 'vitest'
import { SpawnQueue, type SpawnRequest } from '../src/spawn-queue.js'
import { WorkerStarter } from '../src/worker-start.js'
import { attachSpawnEvents } from '../src/spawn-api.js'
import { createTaskLease } from '../src/application/task-lease.js'
import type { LeaseEntry } from '../src/domain/task-lease.js'

// One live session per task in the spawn queue: a pending request holds its task, the user's own start revokes the
// runner's, and a runner request that went stale while it waited for room is dropped instead of started.

const runnerRequest = (spawns: SpawnQueue, taskId = 't1') =>
  spawns.add({ projectId: 'bp-eml', prompt: 'step', title: 'Step', fromSessionId: null, origin: 'runner', taskId })
const ownStart = (spawns: SpawnQueue, taskId = 't1', prompt = 'together') =>
  spawns.add({ projectId: 'bp-eml', prompt, title: 'Task', fromSessionId: null, open: true, origin: 'task', taskId })

describe('the spawn queue and a task\'s lease', () => {
  let spawns: SpawnQueue
  let revoked: Array<[string, string]>
  beforeEach(() => {
    spawns = new SpawnQueue()
    revoked = []
    spawns.on('revoked', (id: string, why: string) => revoked.push([id, why]))
  })

  it('gives a second runner request for the task the pending one back, without a new spawn event', () => {
    const spawned: string[] = []
    spawns.on('spawn', (r: SpawnRequest) => spawned.push(r.id))
    const first = runnerRequest(spawns)
    const again = runnerRequest(spawns)
    expect(again.id).toBe(first.id)
    expect(spawns.list()).toHaveLength(1)
    expect(spawned).toEqual([first.id])
    // Another task is not held by it.
    expect(runnerRequest(spawns, 't2').id).not.toBe(first.id)
  })

  it('lets the user\'s own start on the task revoke a pending runner request', () => {
    const runner = runnerRequest(spawns)
    const own = ownStart(spawns)
    expect(spawns.list().map((r) => r.id)).toEqual([own.id])
    expect(revoked).toEqual([[runner.id, 'the user started a session on task t1']])
    // A runner request now gets the user's pending one back; so does a second own start.
    expect(runnerRequest(spawns).id).toBe(own.id)
    expect(ownStart(spawns, 't1', 'advance').id).toBe(own.id)
  })

  it('names the pending request that holds a task, never a scheduled run', () => {
    spawns.add({ projectId: 'bp-eml', prompt: 'run', title: null, fromSessionId: null, origin: 'job', jobId: 't1', taskId: 't1' })
    expect(spawns.pendingFor('t1')).toBeNull()
    const runner = runnerRequest(spawns)
    expect(spawns.pendingFor('t1')?.id).toBe(runner.id)
  })

  it('revokes the runner requests of a task someone took over, and only those', () => {
    const runner = runnerRequest(spawns)
    const other = runnerRequest(spawns, 't2')
    expect(spawns.revokeRunnerFor('t1', 'taken over').map((r) => r.id)).toEqual([runner.id])
    expect(spawns.list().map((r) => r.id)).toEqual([other.id])
    expect(revoked).toEqual([[runner.id, 'taken over']])
    expect(spawns.revoke(runner.id, 'again')).toBeNull()
  })

  it('tells the open tabs that a revoked request is gone, like a claimed one', () => {
    const sent: Array<[string, unknown]> = []
    const detach = attachSpawnEvents(spawns, (event, data) => sent.push([event, data]))
    const runner = runnerRequest(spawns)
    spawns.revoke(runner.id, 'stale')
    expect(sent.at(-1)).toEqual(['revoked', { id: runner.id }])
    detach()
    spawns.revoke(runnerRequest(spawns).id, 'stale')
    expect(sent.filter(([event]) => event === 'revoked')).toHaveLength(1)
  })
})

class FakeBridge {
  started: SpawnRequest[] = []
  room = true
  startWorker(request: SpawnRequest): string | null { this.started.push(request); return null }
  sweepIdleWorkers(): number { return 0 }
  hasRoom(): boolean { return this.room }
}

describe('fencing a queued runner request when it is about to start', () => {
  let spawns: SpawnQueue
  let bridge: FakeBridge
  let sessions: LeaseEntry[]
  let together: Set<string>
  let starter: WorkerStarter

  beforeEach(() => {
    spawns = new SpawnQueue()
    bridge = new FakeBridge()
    sessions = []
    together = new Set()
    // The host's own check, as index.ts wires it.
    const { stale } = createTaskLease({
      pending: () => spawns.list(), sessions: () => sessions,
      commands: () => ({ together: (t) => together.has(t), held: () => false, undoneSince: () => false }),
      working: () => false, end: async () => {}, answered: () => {},
    })
    starter = new WorkerStarter({ spawns, bridge, stale, log: () => {}, turnOf: () => ({ state: 'done', since: null }) })
  })

  it('drops a runner request whose task the owner now works on, and starts the others', () => {
    const runner = runnerRequest(spawns)
    const worker = spawns.add({ projectId: 'bp-eml', prompt: 'w', title: null, fromSessionId: 'requester' })
    together.add('t1')
    starter.tick()
    expect(bridge.started.map((r) => r.id)).toEqual([worker.id])
    expect(spawns.list().some((r) => r.id === runner.id)).toBe(false)
  })

  it('drops a runner request when a session started on its task meanwhile, also while there is no room', () => {
    bridge.room = false
    const runner = runnerRequest(spawns)
    sessions.push({ sessionId: 'later', taskId: 't1', createdAt: new Date(Date.parse(runner.createdAt) + 1000).toISOString(), archivedAt: null, jobId: null })
    starter.tick()
    expect(spawns.list()).toEqual([])
    bridge.room = true
    starter.tick()
    expect(bridge.started).toEqual([])
  })

  it('starts a runner request when nothing changed', () => {
    const runner = runnerRequest(spawns)
    starter.tick()
    expect(bridge.started.map((r) => r.id)).toEqual([runner.id])
  })

  // A runner request waiting for room, Work on it now and the owner's own session from the page: once room comes free,
  // the task still has one session.
  it('runner queues without room, the owner works on it now, room comes free: exactly one session', () => {
    bridge.room = false
    const runner = runnerRequest(spawns)
    starter.tick()
    expect(bridge.started).toEqual([])
    // Work on it now: the together path revokes the runner request, and the page starts the owner's session.
    together.add('t1')
    spawns.revokeRunnerFor('t1', 'the owner works on the task now')
    const own = ownStart(spawns)
    // A tab claims the owner's session and it starts in the ledger.
    expect(spawns.claim(own.id)?.id).toBe(own.id)
    sessions.push({ sessionId: own.id, taskId: 't1', createdAt: new Date().toISOString(), archivedAt: null, jobId: null })
    bridge.room = true
    starter.tick()
    expect(bridge.started).toEqual([])
    expect(spawns.list()).toEqual([])
    expect(sessions.filter((s) => s.taskId === 't1')).toHaveLength(1)
    expect(runner.id).not.toBe(own.id)
  })

  it('without the revoke (startOnTask alone) the owner\'s start still supersedes the queued runner request', () => {
    bridge.room = false
    runnerRequest(spawns)
    const own = ownStart(spawns)
    bridge.room = true
    starter.tick()
    // The owner's own start waits for a tab (not unattended); the runner's request is gone.
    expect(bridge.started).toEqual([])
    expect(spawns.list().map((r) => r.id)).toEqual([own.id])
  })
})
