import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'
import { validNote, validTask, writes } from './fixtures'

// v0.20: apply() owns the one transaction of a write; the command bodies run
// in it without transactions of their own. A command that fails after it has
// written must leave nothing behind — not the row, not its search entry, not
// the side effects on other engrams.

describe('a command failing mid-way leaves nothing behind', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
    writes(eml).tags.create({ name: 'ops' })
  })

  afterEach(() => eml.close())

  const rawDb = (): any => (eml.engrams as any).db
  const TABLES = ['engrams', 'engrams_fts', 'entries', 'relations', 'engram_tags', 'engram_subjects']
  const dump = () => Object.fromEntries(TABLES.map(t => [t, rawDb().prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]))

  it('engram.create: a parent that is no task fails after the row and the supersede are written', () => {
    const old = writes(eml).store(validTask({ scope: 'project.eml', title: 'old-task' }))
    const bound = writes(eml).store(validNote({ scope: 'project.eml', title: 'old-plan', task_id: old.id, properties: { binding: 'task' } }))
    const notATask = writes(eml).store(validNote({ scope: 'project.eml', title: 'not-a-task' }))
    const before = dump()
    const revBefore = eml.engrams.getRaw(old.id)!.rev

    // The parent's type is checked when part_of is drawn — after the new row,
    // its search entry, its created entry and the supersede of the old task
    // (status flip, rev, journal entries, the bound note moved over).
    expect(() => writes(eml).store(validTask({
      scope: 'project.eml', title: 'new-task', tags: ['ops'],
      supersedes: [old.id], parent_id: notATask.id,
    }))).toThrow(/part_of needs two tasks/)

    expect(dump()).toEqual(before)
    expect(rawDb().prepare(`SELECT count(*) AS c FROM engrams WHERE title = 'new-task'`).get().c).toBe(0)
    const oldNow = eml.engrams.getRaw(old.id)!
    expect(oldNow.status).toBe('planned')
    expect(oldNow.rev).toBe(revBefore)
    expect(eml.engrams.boundItems(old.id).map(b => b.id)).toEqual([bound.id])
  })
})
