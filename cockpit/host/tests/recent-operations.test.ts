import { describe, it, expect } from 'vitest'
import { createRecentOperations, operationId } from '../src/application/recent-operations.js'

// A client's operation by its id: the same id again within the window answers what the first did, without doing it
// again. Only what was done is kept: a refusal or a failure did nothing, so the same id again tries once more.

function recent(opts: { ttlMs?: number; max?: number } = {}) {
  let now = 0
  const operations = createRecentOperations<{ status: number; n: number }>({ ttlMs: opts.ttlMs ?? 1_000, max: opts.max ?? 10, now: () => now })
  let runs = 0
  const work = (status = 200) => async () => ({ status, n: ++runs })
  return { operations, work, runs: () => runs, advance: (ms: number) => { now += ms } }
}

describe('recent operations', () => {
  it('answers a repeat of the same id with the first outcome, running the work once', async () => {
    const { operations, work, runs } = recent()
    expect(await operations.once('op-1', work())).toEqual({ status: 200, n: 1 })
    expect(await operations.once('op-1', work())).toEqual({ status: 200, n: 1 })
    expect(runs()).toBe(1)
  })

  it('a repeat while the first still runs waits for it', async () => {
    const { operations, work, runs } = recent()
    const [a, b] = await Promise.all([operations.once('op-1', work()), operations.once('op-1', work())])
    expect([a, b]).toEqual([{ status: 200, n: 1 }, { status: 200, n: 1 }])
    expect(runs()).toBe(1)
  })

  it('without an id, or another id, the work runs each time', async () => {
    const { operations, work, runs } = recent()
    await operations.once(null, work())
    await operations.once(null, work())
    await operations.once('op-2', work())
    expect(runs()).toBe(3)
  })

  it('keeps no refusal and no failure: the same id runs again', async () => {
    const { operations, work, runs } = recent()
    expect(await operations.once('op-1', work(409))).toEqual({ status: 409, n: 1 })
    expect(await operations.once('op-1', work())).toEqual({ status: 200, n: 2 })
    await expect(operations.once('op-3', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await operations.once('op-3', work())).toEqual({ status: 200, n: 3 })
    expect(runs()).toBe(3)
  })

  it('forgets an id after the window, and the oldest beyond the bound', async () => {
    const { operations, work, runs, advance } = recent({ ttlMs: 1_000, max: 2 })
    await operations.once('op-1', work())
    advance(1_001)
    await operations.once('op-1', work())
    expect(runs()).toBe(2)
    await operations.once('op-2', work())
    await operations.once('op-3', work())
    await operations.once('op-1', work())
    expect(runs()).toBe(5)
  })

  it('takes an operation id from a request body only when it looks like one', () => {
    expect(operationId({ opId: '7f0c2f4e-8d0b-4f7e-9a51-0d8c3a1b2c3d' })).toBe('7f0c2f4e-8d0b-4f7e-9a51-0d8c3a1b2c3d')
    expect(operationId({})).toBeNull()
    expect(operationId({ opId: 42 })).toBeNull()
    expect(operationId({ opId: 'x'.repeat(200) })).toBeNull()
    expect(operationId({ opId: 'has spaces in it' })).toBeNull()
  })
})
