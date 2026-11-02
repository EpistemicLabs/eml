import { describe, it, expect, beforeEach } from 'vitest'
import { SpawnQueue, type SpawnRequest } from '../src/spawn-queue.js'
import { WorkerStarter } from '../src/worker-start.js'

// Workers a session asks for start without a cockpit tab: the host claims a
// request no tab takes and starts it without a pane, while the machine has room.

class FakeBridge {
  started: SpawnRequest[] = []
  idleSweeps: number[] = []
  startWorker(request: SpawnRequest): string | null {
    this.started.push(request)
    return null
  }
  sweepIdleWorkers(idleMs: number): number {
    this.idleSweeps.push(idleMs)
    return 0
  }
  room = true
  hasRoom(): boolean {
    return this.room
  }
}

const request = (spawns: SpawnQueue, fromSessionId: string | null = 'requester', open = true) =>
  spawns.add({ projectId: 'bp-eml', prompt: 'do it', title: null, fromSessionId, open })

describe('worker start without a tab', () => {
  let spawns: SpawnQueue
  let bridge: FakeBridge
  let now: number
  let starter: WorkerStarter

  beforeEach(() => {
    spawns = new SpawnQueue()
    bridge = new FakeBridge()
    now = Date.now()
    starter = new WorkerStarter({
      spawns, bridge, log: () => {}, turnOf: () => ({ state: 'done', since: null }),
      graceMs: 15_000, now: () => now,
    })
  })

  it('starts a request at once when no tab follows the requests, under the request id', () => {
    const r = request(spawns)
    starter.tick()
    expect(bridge.started.map((s) => s.id)).toEqual([r.id])
    expect(spawns.list()).toEqual([])
  })

  it('starts a worker nobody asked a pane for at once, tabs or not', () => {
    const leave = spawns.watch()
    const r = request(spawns, 'requester', false)
    now = Date.parse(r.createdAt)
    starter.tick()
    expect(bridge.started.map((s) => s.id)).toEqual([r.id])
    leave()
  })

  it('leaves a request to an open tab during the grace time, then starts it', () => {
    const leave = spawns.watch()
    const r = request(spawns)
    now = Date.parse(r.createdAt) + 14_999
    starter.tick()
    expect(bridge.started).toEqual([])
    now = Date.parse(r.createdAt) + 15_000
    starter.tick()
    expect(bridge.started.map((s) => s.id)).toEqual([r.id])
    leave()
  })

  it('does not start a request a tab claimed in time', () => {
    const leave = spawns.watch()
    const r = request(spawns)
    expect(spawns.claim(r.id)).not.toBeNull()
    now = Date.parse(r.createdAt) + 20_000
    starter.tick()
    expect(bridge.started).toEqual([])
    leave()
  })

  it('never starts the host\'s own requests (no requesting session)', () => {
    request(spawns, null)
    starter.tick()
    expect(bridge.started).toEqual([])
    expect(spawns.list()).toHaveLength(1)
  })

  it('has no cap: every due request starts while there is room', () => {
    for (let i = 0; i < 5; i += 1) request(spawns)
    new WorkerStarter({ spawns, bridge, turnOf: () => ({ state: 'idle', since: null }), log: () => {} }).tick()
    expect(bridge.started).toHaveLength(5)
  })

  it('a request waits while the machine has little free memory', () => {
    request(spawns)
    bridge.room = false
    const starter = new WorkerStarter({ spawns, bridge, turnOf: () => ({ state: 'idle', since: null }), log: () => {} })
    starter.tick()
    expect(bridge.started).toHaveLength(0)
    expect(spawns.list()).toHaveLength(1)
    bridge.room = true
    starter.tick()
    expect(bridge.started).toHaveLength(1)
  })

  it('sweeps idle workers with the 24-hour limit on every check', () => {
    starter.tick()
    expect(bridge.idleSweeps).toEqual([24 * 60 * 60 * 1000])
  })

  it('counts tabs that follow and leave', () => {
    const a = spawns.watch()
    const b = spawns.watch()
    expect(spawns.watchers()).toBe(2)
    a()
    a()
    expect(spawns.watchers()).toBe(1)
    b()
    expect(spawns.watchers()).toBe(0)
  })
})
