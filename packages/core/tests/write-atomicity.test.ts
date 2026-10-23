import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'
import {
  validDecision, writes,
} from './fixtures'

// v0.10.10 L1: store() and update() wrap their row-write + FTS re-sync (+ the
// status auto-supersede) in a single db.transaction(). A mid-write failure must
// roll back wholesale instead of leaving the engrams table committed but its FTS
// index (or a half-applied supersede) out of sync — silent recall corruption on
// the live write path. We force the failure by dropping engrams_fts so the second
// statement in the write throws, then assert the first statement was rolled back.

describe('write-path atomicity (v0.10.10 L1)', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })

  afterEach(() => eml.close())

  // white-box: reach the underlying brain DB to sabotage the FTS table
  const rawDb = (): any => (eml.engrams as any).db
  const engramCount = (): number =>
    (rawDb().prepare('SELECT count(*) AS c FROM engrams').get() as { c: number }).c

  it('store(): a failing FTS insert rolls back the engram row (no half-write)', () => {
    writes(eml).store(validDecision({ scope: 'project.eml', title: 'seed', content: 'alpha one' }))
    const before = engramCount()

    rawDb().exec('DROP TABLE engrams_fts')   // next store()'s FTS insert will throw

    expect(() => writes(eml).store(validDecision({
      scope: 'project.eml', title: 'doomed', content: 'beta two',
    }))).toThrow()

    // transaction rolled back → engrams table unchanged, no orphaned row
    expect(engramCount()).toBe(before)
  })

  it('update(): a failing FTS re-sync rolls back the row update', () => {
    const e = writes(eml).store(validDecision({ scope: 'project.eml', title: 'orig', content: 'original content' }))

    rawDb().exec('DROP TABLE engrams_fts')   // update() re-syncs FTS on content change → throws

    expect(() => writes(eml).update(e.id, { content: 'mutated content' })).toThrow()

    // the row must still carry the original content — UPDATE rolled back with the FTS failure
    const row = rawDb().prepare('SELECT content FROM engrams WHERE id = ?').get(e.id) as { content: string }
    expect(row.content).toBe('original content')
  })
})
