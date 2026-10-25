import { describe, it, expect, beforeEach } from 'vitest'
import { SpawnQueue, type SpawnRequest } from '../src/spawn-queue.js'
import { WorkerStarter } from '../src/worker-start.js'

// Workers a session asks for start without a cockpit tab: the host claims a
// request no tab takes and starts it without a pane, at most three at a time.

class FakeBridge {
  started: SpawnRequest[] = []
  unattended = 0
  idleSweeps: number[] = []
  startWorker(request: SpawnRequest): string | null {
    this.started.push(request)
    this.unattended += 1
    return null
  }
  unattendedWorkers(): number {
    return this.unattended
  }
  sweepIdleWorkers(idleMs: number): number {
    this.idleSweeps.push(idleMs)
    return 0
  }
}

const request = (spawns: SpawnQueue, fromSessionId: string | null = 'requester') =>
  spawns.add({ projectId: 'bp-eml', prompt: 'do it', title: null, fromSessionId })

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
      spawns, bridge, log: () => {}, turnOf: () => ({ working: false, since: null }),
      graceMs: 15_000, now: () => now,
    })
  })

  it('starts a request at once when no tab follows the requests, under the request id', () => {
    const r = request(spawns)
    starter.tick()
    expect(bridge.started.map((s) => s.id)).toEqual([r.id])
    expect(spawns.list()).toEqual([])
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

  it('runs at most three without a client; the fourth waits until one ends', () => {
    const rs = [request(spawns), request(spawns), request(spawns), request(spawns)]
    starter.tick()
    expect(bridge.started).toHaveLength(3)
    expect(spawns.list().map((s) => s.id)).toEqual([rs[3].id])
    bridge.unattended = 2
    starter.tick()
    expect(bridge.started.map((s) => s.id)).toContain(rs[3].id)
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
