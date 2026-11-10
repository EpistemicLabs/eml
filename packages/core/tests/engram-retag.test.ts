import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, CommandError } from '../src'
import { closedTask, validDecision, validNote, validStatus } from './fixtures'

// engram.retag: a re-sort of the tag vocabulary adds and removes tags on many
// engrams without reading as an edit, so history can carry the new tags too.

describe('engram.retag', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'juno' })
    eml.apply({ name: 'object.create', input: { object: 'project', fields: { id: 'p', name: 'P' } } })
    for (const name of ['old', 'area', 'other']) eml.apply({ name: 'object.create', input: { object: 'tag', fields: { name } } })
  })
  afterEach(() => eml.close())

  const create = (input: any) => eml.apply({ name: 'engram.create', input }) as any
  const retag = (ids: string[], add: string[] = [], remove: string[] = []) => eml.apply({ name: 'engram.retag', input: { ids, add, remove } })
  const row = (id: string) => (eml as any).db.prepare('SELECT * FROM engrams WHERE id = ?').get(id)
  const tags = (id: string) => ((eml as any).db.prepare('SELECT tag_id FROM engram_tags WHERE engram_id = ? ORDER BY tag_id').all(id) as Array<{ tag_id: string }>).map(r => r.tag_id)
  const archive = (id: string) => eml.apply({ name: 'object.update', input: { object: 'tag', id, patch: { status: 'archived' } } })
  const reject = (f: () => unknown): CommandError => {
    try { f() } catch (e) { if (e instanceof CommandError) return e; throw e }
    throw new Error('not rejected')
  }

  it('swaps tags on one engram: the tags change and rev goes up, nothing else', () => {
    const d = create(validDecision({ scope: 'project.p', tags: ['old'] }))
    const before = row(d.id)
    expect(retag([d.id], ['area'], ['old'])).toEqual({ changed: 1, unchanged: 0 })
    expect(tags(d.id)).toEqual(['area'])
    expect(row(d.id)).toEqual({ ...before, rev: before.rev + 1 })
  })

  it('retags many of any type and status, closed tasks and old statuses included', () => {
    const closed = closedTask(eml, { scope: 'project.p', tags: ['old'] })
    const old = create(validStatus({ scope: 'project.p', tags: ['old'] }))
    create(validStatus({ scope: 'project.p' }))
    expect(row(old.id).status).toBe('superseded')
    expect(retag([closed.id, old.id], ['area'], ['old'])).toEqual({ changed: 2, unchanged: 0 })
    expect(tags(closed.id)).toEqual(['area'])
    expect(tags(old.id)).toEqual(['area'])
    expect(row(closed.id).status).toBe('resolved')
  })

  it('takes an archived tag off, but does not assign one anew', () => {
    const d = create(validDecision({ scope: 'project.p', tags: ['old'] }))
    archive('old')
    expect(retag([d.id], [], ['old'])).toEqual({ changed: 1, unchanged: 0 })
    expect(tags(d.id)).toEqual([])
    expect(reject(() => retag([d.id], ['old'])).code).toBe('INVALID')
  })

  it('leaves other tags alone and can be repeated', () => {
    const a = create(validDecision({ scope: 'project.p', tags: ['old', 'other'] }))
    const b = create(validNote({ scope: 'project.p', tags: ['area'] }))
    expect(retag([a.id, b.id], ['area'], ['old'])).toEqual({ changed: 1, unchanged: 1 })
    expect(tags(a.id)).toEqual(['area', 'other'])
    const rev = row(a.id).rev
    expect(retag([a.id, b.id], ['area'], ['old'])).toEqual({ changed: 0, unchanged: 2 })
    expect(row(a.id).rev).toBe(rev)
  })

  it('changes nothing when one id or tag is unknown', () => {
    const d = create(validDecision({ scope: 'project.p', tags: ['old'] }))
    expect(reject(() => retag([d.id, 'ghost'], ['area'])).code).toBe('NOT_FOUND')
    expect(reject(() => retag([d.id], ['nope'])).code).toBe('INVALID')
    expect(reject(() => retag([d.id], [], ['nope'])).code).toBe('INVALID')
    expect(tags(d.id)).toEqual(['old'])
  })

  it('refuses a malformed input', () => {
    const d = create(validDecision({ scope: 'project.p' }))
    expect(reject(() => retag([d.id])).code).toBe('INVALID')
    expect(reject(() => retag([], ['area'])).code).toBe('INVALID')
    expect(reject(() => retag([d.id, d.id], ['area'])).code).toBe('INVALID')
    expect(reject(() => retag([d.id], ['area'], ['area'])).code).toBe('INVALID')
    expect(reject(() => eml.apply({ name: 'engram.retag', input: { ids: [d.id], add: ['area'], scope: 'x' } as never })).code).toBe('INVALID')
  })
})
