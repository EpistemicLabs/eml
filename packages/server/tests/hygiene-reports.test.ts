import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CURRENT_BRAIN_SCHEMA_VERSION, type ConflictSweepState } from '@engramprotocol/core'
import { FULL_AFTER_MS, HygieneReports, REFRESH_AFTER_MS, STALE_AFTER_MS, keptHygiene } from '../src/hygiene-reports'
import type { HygieneSweepAnswer } from '../src/reads'

// The kept hygiene reports (hygiene-reports.ts), with a sweep that only counts.

const T0 = Date.parse('2026-11-25T09:00:00.000Z')
const BRAIN = '5fa3766c-160c-4fca-b4f2-d38a0d782a24'

let dir: string
let now: number
let head: number
/** What each sweep was started with: undefined = over everything. */
let sweeps: Array<ConflictSweepState | undefined>
const logged: string[] = []

const sweep = async (previous?: ConflictSweepState): Promise<HygieneSweepAnswer> => {
  sweeps.push(previous)
  const computed_at = new Date(now).toISOString()
  return {
    seq: head,
    computed_at,
    report: { schema: CURRENT_BRAIN_SCHEMA_VERSION, checks: [], total: sweeps.length },
    conflicts: { revs: { [`engram-${sweeps.length}`]: 1 }, ids: [`pair-${sweeps.length}`] },
  }
}
const reports = (version = '1.0.0') => new HygieneReports({ dir, version, now: () => now, log: (line) => logged.push(line) })
const brain = { id: BRAIN, head: () => head }
/** Let a sweep started in the background finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eml-hygiene-reports-'))
  now = T0
  head = 10
  sweeps = []
  logged.length = 0
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('HygieneReports', () => {
  it('sweeps the whole brain for a brain without a report, and waits for it', async () => {
    const kept = await reports().get(brain, sweep)
    expect(sweeps).toEqual([undefined])
    expect(kept).toMatchObject({ seq: 10, computed_at: new Date(T0).toISOString(), full_at: new Date(T0).toISOString(), report: { total: 1 } })
  })

  it('answers from the kept report while the brain did not change and the report is under an hour old', async () => {
    const r = reports()
    await r.get(brain, sweep)
    now += STALE_AFTER_MS - 1
    expect((await r.get(brain, sweep, { fresh: true })).report.total).toBe(1)
    expect((await r.get(brain, sweep)).report.total).toBe(1)
    await settle()
    expect(sweeps).toHaveLength(1)
  })

  it('sweeps again after an hour without any write: a review falls due by the clock', async () => {
    // the sweep finds what is due at its time: one review falls due 90 minutes after the first sweep
    const dueAt = T0 + 90 * 60_000
    const byClock = async (previous?: ConflictSweepState): Promise<HygieneSweepAnswer> => {
      const answer = await sweep(previous)
      return { ...answer, report: { ...answer.report, total: now >= dueAt ? 1 : 0 } }
    }
    const r = reports()
    expect((await r.get(brain, byClock)).report.total).toBe(0)
    now = dueAt + 1
    // the kept report for this caller, a sweep for the next — no write moved the head
    expect((await r.get(brain, byClock)).report.total).toBe(0)
    await settle()
    expect(sweeps).toHaveLength(2)
    expect((await r.get(brain, byClock)).report.total).toBe(1)
  })

  it('waits for a sweep with fresh once the report is an hour old, also without a write', async () => {
    const r = reports()
    await r.get(brain, sweep)
    now += STALE_AFTER_MS
    expect(await r.get(brain, sweep, { fresh: true })).toMatchObject({ seq: 10, report: { total: 2 }, computed_at: new Date(now).toISOString() })
  })

  it('answers from the kept report after a change, and sweeps again only once it is ten minutes old', async () => {
    const r = reports()
    await r.get(brain, sweep)
    head = 11
    now += REFRESH_AFTER_MS - 1
    expect((await r.get(brain, sweep)).report.total).toBe(1)
    await settle()
    expect(sweeps).toHaveLength(1)
    now += 1
    // still the kept one for this caller; the sweep it started is for the next
    expect((await r.get(brain, sweep)).report.total).toBe(1)
    await settle()
    expect(sweeps).toHaveLength(2)
    expect((await r.get(brain, sweep))).toMatchObject({ seq: 11, report: { total: 2 } })
  })

  it('starts the next sweep from the last one, and keeps when the whole brain was read last', async () => {
    const r = reports()
    const first = await r.get(brain, sweep)
    head = 11
    now += REFRESH_AFTER_MS
    const second = await r.get(brain, sweep, { fresh: true })
    expect(sweeps[1]).toEqual(first.conflicts)
    expect(second.full_at).toBe(first.full_at)
    expect(second.computed_at).not.toBe(first.computed_at)
  })

  it('reads the whole brain again after a day', async () => {
    const r = reports()
    await r.get(brain, sweep)
    head = 11
    now += FULL_AFTER_MS
    const kept = await r.get(brain, sweep, { fresh: true })
    expect(sweeps).toEqual([undefined, undefined])
    expect(kept.full_at).toBe(new Date(now).toISOString())
  })

  it('reads the whole brain again when its log went back (another brain under the id)', async () => {
    const r = reports()
    await r.get(brain, sweep)
    head = 4
    // not the kept report of the brain that was there before: the caller waits for this brain's
    expect(await r.get(brain, sweep)).toMatchObject({ seq: 4, report: { total: 2 } })
    expect(sweeps).toEqual([undefined, undefined])
  })

  it('waits for a sweep with fresh when the brain changed, whatever the report\'s age', async () => {
    const r = reports()
    await r.get(brain, sweep)
    head = 11
    expect(await r.get(brain, sweep, { fresh: true })).toMatchObject({ seq: 11, report: { total: 2 } })
  })

  /** A sweep the test lets finish: it reads the head when it starts, as a real one does. */
  const held = () => {
    const waiting: Array<() => void> = []
    let count = 0
    const slow = async (previous?: ConflictSweepState): Promise<HygieneSweepAnswer> => {
      const answer = await sweep(previous)
      count++
      await new Promise<void>((resolve) => { waiting.push(resolve) })
      return answer
    }
    return { slow, started: () => count, finish: () => waiting.shift()!() }
  }

  it('does not answer fresh with a sweep that started before the last write: one more sweep runs', async () => {
    const r = reports()
    await r.get(brain, sweep)
    const { slow, started, finish } = held()
    head = 11
    now += REFRESH_AFTER_MS
    await r.get(brain, slow) // starts the background sweep, which reads head 11
    await settle()
    expect(started()).toBe(1)
    head = 12 // written while that sweep runs
    const fresh = r.get(brain, slow, { fresh: true })
    finish()
    await settle()
    expect(started()).toBe(2)
    finish()
    expect(await fresh).toMatchObject({ seq: 12, report: { total: 3 } })
    // the extra sweep started from the one before it
    expect(sweeps[2]).toEqual({ revs: { 'engram-2': 1 }, ids: ['pair-2'] })
  })

  it('answers fresh with the sweep under way when that one read the brain as it is', async () => {
    const r = reports()
    await r.get(brain, sweep)
    const { slow, finish } = held()
    head = 11
    now += REFRESH_AFTER_MS
    await r.get(brain, slow)
    await settle()
    const fresh = r.get(brain, slow, { fresh: true })
    finish()
    expect(await fresh).toMatchObject({ seq: 11, report: { total: 2 } })
    expect(sweeps).toHaveLength(2)
  })

  it('does not take a sweep that started from the brain before as this brain\'s when the log went back', async () => {
    const r = reports()
    await r.get(brain, sweep)
    const { slow, started, finish } = held()
    head = 11
    now += REFRESH_AFTER_MS
    await r.get(brain, slow) // a sweep from the old brain's state is under way
    await settle()
    head = 3 // the brain was replaced
    const answer = r.get(brain, slow)
    finish()
    await settle()
    expect(started()).toBe(2)
    finish()
    expect((await answer).seq).toBe(3)
    expect(sweeps[2]).toBeUndefined()
  })

  it('keeps nothing of a sweep that was under way when its brain was forgotten', async () => {
    const r = reports()
    const { slow, finish } = held()
    const first = r.get(brain, slow)
    await settle()
    r.forget(BRAIN)
    finish()
    // the caller that waited still gets its answer
    expect((await first).report.total).toBe(1)
    expect(existsSync(join(dir, `${BRAIN}.json`))).toBe(false)
    // nothing in memory either: the next request sweeps
    await r.get(brain, sweep)
    expect(sweeps).toHaveLength(2)
  })

  it('runs one sweep per brain at a time', async () => {
    const r = reports()
    const [a, b] = await Promise.all([r.get(brain, sweep), r.get(brain, sweep)])
    expect(sweeps).toHaveLength(1)
    expect(a).toBe(b)
  })

  it('says when a background sweep failed, and keeps answering from the kept report', async () => {
    const r = reports()
    await r.get(brain, sweep)
    head = 11
    now += REFRESH_AFTER_MS
    expect((await r.get(brain, async () => { throw new Error('the worker is gone') })).report.total).toBe(1)
    await settle()
    expect(logged.join('\n')).toContain('the worker is gone')
    // the next request tries again
    await r.get(brain, sweep)
    await settle()
    expect(sweeps).toHaveLength(2)
  })

  it('fails the request when the first sweep fails', async () => {
    await expect(reports().get(brain, async () => { throw new Error('the worker is gone') })).rejects.toThrow('the worker is gone')
  })

  it('starts from the file after a restart: no sweep for an unchanged brain', async () => {
    await reports().get(brain, sweep)
    expect(existsSync(join(dir, `${BRAIN}.json`))).toBe(true)
    const kept = await reports().get(brain, sweep)
    expect(sweeps).toHaveLength(1)
    expect(kept).toMatchObject({ seq: 10, report: { total: 1 } })
  })

  it('takes a file that is not a report, or one of another server version, as none', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${BRAIN}.json`), '{ not json')
    await reports().get(brain, sweep)
    expect(sweeps).toHaveLength(1)
    // written over by the sweep
    expect(keptHygiene(JSON.parse(readFileSync(join(dir, `${BRAIN}.json`), 'utf-8')), '1.0.0')).not.toBeNull()
    await reports('1.0.1').get(brain, sweep)
    expect(sweeps).toEqual([undefined, undefined])
  })

  it('forgets a brain: its report and its file', async () => {
    const r = reports()
    await r.get(brain, sweep)
    r.forget(BRAIN)
    expect(existsSync(join(dir, `${BRAIN}.json`))).toBe(false)
    await r.get(brain, sweep)
    expect(sweeps).toEqual([undefined, undefined])
  })

  it('keeps no file for an id that is no file name', async () => {
    await reports().get({ id: '../evil', head: () => head }, sweep)
    expect(existsSync(join(dir, '..', 'evil.json'))).toBe(false)
  })
})

describe('keptHygiene', () => {
  const good = { version: '1', schema: CURRENT_BRAIN_SCHEMA_VERSION, seq: 1, computed_at: '2026-11-25T09:00:00.000Z', full_at: '2026-11-25T09:00:00.000Z', report: { schema: CURRENT_BRAIN_SCHEMA_VERSION, checks: [], total: 0 }, conflicts: { revs: { a: 1 }, ids: [] } }
  it('takes a report of this version and schema', () => {
    expect(keptHygiene(good, '1')).toEqual(good)
  })
  it.each([
    ['another schema', { ...good, schema: CURRENT_BRAIN_SCHEMA_VERSION - 1 }],
    ['no seq', { ...good, seq: 'x' }],
    ['a time that is none', { ...good, computed_at: 'yesterday' }],
    ['no report', { ...good, report: null }],
    ['ids that are no strings', { ...good, conflicts: { revs: {}, ids: [1] } }],
    ['revs that are no numbers', { ...good, conflicts: { revs: { a: '1' }, ids: [] } }],
    ['the state of a sweep by time', { ...good, conflicts: { since: '2026-11-25T09:00:00.000Z', ids: [] } }],
    ['not an object', [good]],
  ])('refuses %s', (_name, value) => {
    expect(keptHygiene(value, '1')).toBeNull()
  })
})
