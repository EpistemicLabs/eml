import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML } from '../src'
import { rebuild, verify } from '../src/log/rebuild'
import { stateDump, stateHash } from '../src/log/snapshot'
import { createV20Brain, validDecision, validNote, writes, writeEverything } from './fixtures'

// v0.21 (spec local-op-log-spec, block 4): a brain is its log. The genesis
// snapshot and every op after it, replayed as stored, give the live state
// again — and a log that was changed after the fact does not verify.

const START = Date.parse('2026-10-26T08:00:00.000Z')

function brain(dbPath = ':memory:'): EML {
  let t = START
  let n = 0
  return new EML({
    dbPath, namespace: 'test',
    clock: () => new Date(t++).toISOString(),
    newId: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
  })
}

const raw = (eml: EML): Database.Database => (eml as any).db

/** writeEverything plus the base_rev path: one update at the current rev, one rejected at a stale rev. */
function writeAll(eml: EML): void {
  writeEverything(eml)
  const d = writes(eml).store(validDecision({ title: 'rev-checked' }))
  eml.apply({ name: 'engram.update', input: { id: d.id, patch: { content: 'at rev 1' }, base_rev: 1 } })
  expect(() => eml.apply({ name: 'engram.update', input: { id: d.id, patch: { content: 'stale' }, base_rev: 1 } })).toThrow(/changed since rev 1/)
}

describe('rebuild from the log equals the live brain', () => {
  it('every command with its side effects (supersede, closing with bound items, evidence, base_rev, objects)', () => {
    const eml = brain()
    writeAll(eml)
    const result = verify(raw(eml))
    expect(result).toEqual({ ok: true, entries: expect.any(Number), state_hash: stateHash(stateDump(raw(eml))) })
    if (!result.ok) throw new Error(result.problem)
    expect(result.entries).toBeGreaterThan(40)

    const into = new Database(':memory:')
    rebuild(into, raw(eml))
    expect(stateDump(into)).toEqual(stateDump(raw(eml)))
    into.close()
    eml.close()
  })

  describe('a brain migrated from v0.20', () => {
    let dir: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-replay-')) })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('replays its writes on top of the genesis snapshot of its old rows', () => {
      const file = join(dir, 'v20.db')
      createV20Brain(file)
      const eml = brain(file)
      expect(verify(raw(eml))).toMatchObject({ ok: true, entries: 1 })
      // writes on the rows from before the log (the fixture's agent, project, tag, subject, decision and task)
      const env = eml.env({ handle: 'juno' })
      writes(eml).trackTask('t-1', { status: 'active', text: 'picked up again', subjects: ['launch'] }, env)
      writes(eml).update('d-1', { content: 'chose the test option, again', tags: ['ops'] }, env)
      writes(eml).relate({ source_id: 'd-1', target_id: 't-1', relation: 'refines', detection_method: 'manual' }, env)
      const plan = writes(eml).store(validNote({ scope: 'project.p', title: 'plan', task_id: 't-1', properties: { binding: 'task' } }), env)
      const next = writes(eml).store(validDecision({ scope: 'project.p', title: 'pick-again', supersedes: ['d-1'] }), env)
      writes(eml).trackTask('t-1', { status: 'resolved', outcome: 'done', text: 'closed', keep: [plan.id] }, env)
      writes(eml).confirmReview(next.id, 'still holds', env)
      writes(eml).projects.update('p', { goal: 'ship' }, env)
      expect(verify(raw(eml))).toMatchObject({ ok: true, entries: 9 })
      eml.close()
    })
  })
})

describe('a log changed after the fact does not verify', () => {
  let eml: EML
  beforeEach(() => {
    eml = brain()
    for (const title of ['one', 'two', 'three']) writes(eml).store(validNote({ title }))
    expect(verify(raw(eml)).ok).toBe(true)
  })
  afterEach(() => eml.close())

  it('a changed payload', () => {
    raw(eml).prepare(`UPDATE op_log SET payload = replace(payload, '"title":"two"', '"title":"TWO"') WHERE seq = 3`).run()
    expect(verify(raw(eml))).toEqual({ ok: false, seq: 3, problem: 'the payload does not match its payload_hash' })
  })

  it('a changed payload with its payload_hash recomputed', () => {
    const db = raw(eml)
    db.prepare(`UPDATE op_log SET payload = replace(payload, '"title":"two"', '"title":"TWO"') WHERE seq = 3`).run()
    const { payload } = db.prepare('SELECT payload FROM op_log WHERE seq = 3').get() as { payload: string }
    db.prepare('UPDATE op_log SET payload_hash = ? WHERE seq = 3').run(createHash('sha256').update(payload).digest('hex'))
    expect(verify(db)).toEqual({ ok: false, seq: 3, problem: 'the chain link does not match its seq, at and hashes' })
  })

  it('a changed time', () => {
    raw(eml).prepare(`UPDATE op_log SET at = '2026-10-26T07:00:00.000Z' WHERE seq = 2`).run()
    expect(verify(raw(eml))).toEqual({ ok: false, seq: 2, problem: 'the chain link does not match its seq, at and hashes' })
  })

  it('a gap in seq', () => {
    raw(eml).prepare('DELETE FROM op_log WHERE seq = 3').run()
    expect(verify(raw(eml))).toEqual({ ok: false, seq: 3, problem: 'entry 3 is missing (the next one is 4)' })
  })

  it('a state changed outside the log', () => {
    raw(eml).prepare(`UPDATE engrams SET content = 'edited by hand' WHERE title = 'two'`).run()
    expect(verify(raw(eml))).toEqual({ ok: false, table: 'engrams', problem: 'the rebuilt engrams differs from the live brain' })
  })

  it('a changed genesis snapshot', () => {
    raw(eml).prepare(`UPDATE op_snapshots SET state_hash = '${'1'.repeat(64)}' WHERE seq = 1`).run()
    expect(verify(raw(eml))).toEqual({ ok: false, seq: 1, problem: 'the genesis snapshot does not match the genesis state_hash' })
  })
})
