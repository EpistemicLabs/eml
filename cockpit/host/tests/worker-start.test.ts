import { describe, it, expect, beforeEach } from 'vitest'
import { SpawnQueue, type SpawnRequest } from '../src/spawn-queue.js'
import { WorkerStarter } from '../src/worker-start.js'
import { pickQuietWorker } from '../src/pty-bridge.js'

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
  canEvict = false
  evicted = 0
  evictQuietWorker(): boolean {
    if (!this.canEvict) return false
    this.evicted += 1
    this.unattended -= 1
    return true
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

  it('a fourth makes room by ending the quietest worker when one has been quiet long enough', () => {
    request(spawns); request(spawns); request(spawns)
    starter.tick()
    bridge.canEvict = true
    const fourth = request(spawns)
    starter.tick()
    expect(bridge.evicted).toBe(1)
    expect(bridge.started.map((s) => s.id)).toContain(fourth.id)
  })

  it('runs at most three without a client; the fourth waits when none is quiet long enough', () => {
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

describe('which quiet worker makes room', () => {
  const hour = 60 * 60 * 1000
  it('picks the one quiet the longest, once quiet for an hour', () => {
    expect(pickQuietWorker([
      { key: 'a', quietMs: 2 * hour, state: 'done' },
      { key: 'b', quietMs: 5 * hour, state: 'done' },
      { key: 'c', quietMs: 30 * 60 * 1000, state: 'done' },
    ], hour)).toBe('b')
  })

  it('takes a done one before one waiting for a permission, and never a working one', () => {
    expect(pickQuietWorker([
      { key: 'waiting', quietMs: 9 * hour, state: 'waiting' },
      { key: 'done', quietMs: 2 * hour, state: 'done' },
      { key: 'working', quietMs: 20 * hour, state: 'working' },
    ], hour)).toBe('done')
    expect(pickQuietWorker([{ key: 'waiting', quietMs: 9 * hour, state: 'waiting' }], hour)).toBe('waiting')
    expect(pickQuietWorker([{ key: 'working', quietMs: 20 * hour, state: 'working' }], hour)).toBeNull()
  })

  it('picks none when all were active within the hour (a reply may still come)', () => {
    expect(pickQuietWorker([{ key: 'a', quietMs: 59 * 60 * 1000, state: 'done' }], hour)).toBeNull()
  })
})
