import { describe, it, expect } from 'vitest'
import { EML } from '@engramprotocol/core'
import Database from 'better-sqlite3'
import { HeadReadError, headFailure, headQuery, logHead, waitForHead, HEAD_WAIT_MAX_MS } from '../src/head'
import { validTask, writes } from '../../core/tests/fixtures'

/** A clock that moves only when the wait sleeps. */
function fakeTime() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

describe('logHead', () => {
  it('is the newest seq of the op log and moves with every write', () => {
    const eml = new EML({ dbPath: ':memory:' })
    const db = (eml as unknown as { db: Parameters<typeof logHead>[0] }).db
    const before = logHead(db)
    writes(eml).store(validTask())
    const after = logHead(db)
    expect(after).toBeGreaterThan(before)
    writes(eml).trackTask(writes(eml).store(validTask({ title: 'second' })).id, { text: 'progress' })
    expect(logHead(db)).toBeGreaterThan(after + 1)
  })
})

describe('waitForHead', () => {
  it('answers at once when the head already differs from after', async () => {
    const time = fakeTime()
    expect(await waitForHead(() => 7, 5, 10_000, time)).toBe(7)
    expect(time.now()).toBe(0)
  })

  it('answers when a write moves the head, not later', async () => {
    const time = fakeTime()
    const head = () => (time.now() >= 600 ? 6 : 5)
    expect(await waitForHead(head, 5, 10_000, { ...time, tickMs: 200 })).toBe(6)
    expect(time.now()).toBe(600)
  })

  it('answers a head that went back too (a replaced brain)', async () => {
    expect(await waitForHead(() => 2, 5, 10_000, fakeTime())).toBe(2)
  })

  it('gives up after wait, capped at the maximum', async () => {
    const time = fakeTime()
    expect(await waitForHead(() => 5, 5, 1_000, time)).toBe(5)
    expect(time.now()).toBe(1_000)
    const long = fakeTime()
    await waitForHead(() => 5, 5, 10 * HEAD_WAIT_MAX_MS, long)
    expect(long.now()).toBe(HEAD_WAIT_MAX_MS)
  })

  it('stops when the caller left', async () => {
    const time = fakeTime()
    await waitForHead(() => 5, 5, 10_000, { ...time, closed: () => time.now() >= 400 })
    expect(time.now()).toBe(400)
  })
})

describe('headQuery', () => {
  it('reads after and wait, capping wait', () => {
    expect(headQuery({})).toEqual({ after: null, wait: 0 })
    expect(headQuery({ after: '12', wait: '999999' })).toEqual({ after: 12, wait: HEAD_WAIT_MAX_MS })
  })
  it('refuses what is not a whole number', () => {
    expect(headQuery({ after: '-1' })).toHaveProperty('error')
    expect(headQuery({ wait: 'soon' })).toHaveProperty('error')
  })
})

describe('headFailure', () => {
  it('answers 501 NO_LOG only for a brain without an op log', () => {
    const db = new Database(':memory:')
    let failure: unknown
    try { logHead(db) } catch (err) { failure = err }
    expect(headFailure(failure)).toEqual({ status: 501, body: { error: 'This brain has no op log to watch', code: 'NO_LOG' } })
  })
  it('keeps the status and code of a routing refusal, so the caller knows whether to retry', () => {
    expect(headFailure(new HeadReadError(503, 'BRAIN_BEHIND_CODE', 'brain is on schema v20'))).toEqual({ status: 503, body: { error: 'brain is on schema v20', code: 'BRAIN_BEHIND_CODE' } })
  })
  it('answers any other failure with a 500 the caller retries', () => {
    expect(headFailure(new Error('database is locked'))).toMatchObject({ status: 500, body: { code: 'HEAD_READ_FAILED' } })
  })
})
