import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'
import { validRule } from './fixtures'

// A substantive update of an active decision, rule or profile restarts its
// review cycle (decision 60 / rule 90 / profile 180 days).
describe('review cycle on update', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'assistant' })
    eml.agents.store({ id: 'assistant', name: 'Assistant' })
  })
  afterEach(() => { eml.close() })

  const due = (id: string) => eml.engrams.getRaw(id)!.properties!.review_due_at as string
  const reviewDue = (id: string) => eml.engrams.getRaw(id)!.review_due
  const makeDue = (id: string) => {
    const db = (eml as any).db
    const props = JSON.parse(db.prepare('SELECT properties FROM engrams WHERE id = ?').get(id).properties)
    db.prepare('UPDATE engrams SET properties = ? WHERE id = ?').run(JSON.stringify({ ...props, review_due_at: '2020-01-01T00:00:00.000Z' }), id)
    expect(reviewDue(id)).toBe(true)
  }

  it('restarts on a content change: review_due_at moves forward, it is no longer review due', () => {
    const r = eml.engrams.store(validRule({ title: 'r', content: 'do Y' }))
    makeDue(r.id)
    eml.engrams.update(r.id, { content: 'do Z' })
    expect(Date.parse(due(r.id))).toBeGreaterThan(Date.now() + 80 * 86400_000)
    expect(reviewDue(r.id)).toBe(false)
  })

  it('restarts on a field change, on a review_note (a confirmation without a change) or a title change', () => {
    const r = eml.engrams.store(validRule({ title: 'r', content: 'do Y' }))
    makeDue(r.id)
    eml.engrams.update(r.id, { properties: { detail: 'more' } })
    expect(Date.parse(due(r.id))).toBeGreaterThan(Date.now())
    expect(reviewDue(r.id)).toBe(false)
    makeDue(r.id)
    eml.engrams.update(r.id, { review_note: 'still holds' })
    expect(Date.parse(due(r.id))).toBeGreaterThan(Date.now())
    expect(reviewDue(r.id)).toBe(false)
    expect(eml.engrams.entries(r.id, ['review']).map(e => e.text)).toEqual(['still holds'])
    makeDue(r.id)
    eml.engrams.update(r.id, { title: 'r2' })
    expect(reviewDue(r.id)).toBe(false)
  })

  it('does not restart on tags or an unchanged content', () => {
    eml.tags.create({ name: 'ops' })
    const r = eml.engrams.store(validRule({ title: 'r', content: 'do Y' }))
    makeDue(r.id)
    eml.engrams.update(r.id, { tags: ['ops'] })
    eml.engrams.update(r.id, { content: 'do Y' })
    expect(due(r.id)).toBe('2020-01-01T00:00:00.000Z')
    expect(reviewDue(r.id)).toBe(true)
  })

  it('keeps an explicit review_due_at from the patch, and it is no longer review due', () => {
    const r = eml.engrams.store(validRule({ title: 'r', content: 'do Y' }))
    makeDue(r.id)
    eml.engrams.update(r.id, { content: 'do Z', properties: { review_due_at: '2030-05-05T00:00:00.000Z' } })
    expect(due(r.id)).toBe('2030-05-05T00:00:00.000Z')
    expect(reviewDue(r.id)).toBe(false)
  })

  // v0.19 (S7) makes null clear an optional field; v0.18 read review_due_at: null
  // as "not given" and restarted the cycle. With the v0.19 core the null deletes
  // review_due_at and nothing restarts it — reported as an open question, see the
  // build report. Kept as a todo until it is settled.
  it('treats review_due_at: null in a substantive patch as not given (v0.18 behaviour)', () => {
    const r = eml.engrams.store(validRule({ title: 'r', content: 'do Y' }))
    makeDue(r.id)
    eml.engrams.update(r.id, { content: 'do Z', properties: { review_due_at: null } })
    expect(Date.parse(due(r.id))).toBeGreaterThan(Date.now() + 80 * 86400_000)
    expect(reviewDue(r.id)).toBe(false)
  })

  it('uses the type default: decision 60 days, profile 180 days; a title change restarts too', () => {
    const days = (id: string) => Math.round((Date.parse(due(id)) - Date.now()) / 86400_000)
    const d = eml.engrams.store({ type: 'decision', scope: 'global', title: 'd', content: 'we chose X', properties: { rationale: 'r', alternatives: ['Y'] } })
    makeDue(d.id)
    eml.engrams.update(d.id, { content: 'we chose X, again' })
    expect(days(d.id)).toBe(60)
    const p = eml.engrams.store({ type: 'profile', scope: 'agent.assistant', title: 'p', content: 'a' })
    makeDue(p.id)
    eml.engrams.update(p.id, { title: 'p2' })
    expect(days(p.id)).toBe(180)
  })

  it('does not restart when the update also takes the entry out of active, nor on a status-only reactivation', () => {
    const r = eml.engrams.store(validRule({ title: 'r', content: 'do Y' }))
    makeDue(r.id)
    eml.engrams.update(r.id, { content: 'do Z', status: 'invalidated' })
    expect(due(r.id)).toBe('2020-01-01T00:00:00.000Z')
    eml.engrams.update(r.id, { status: 'active' })
    expect(due(r.id)).toBe('2020-01-01T00:00:00.000Z')
  })

  it('leaves types without a review date alone', () => {
    const n = eml.engrams.store({ type: 'note', scope: 'global', title: 'n', content: 'a' })
    eml.engrams.update(n.id, { content: 'b' })
    expect(eml.engrams.getRaw(n.id)!.properties?.review_due_at).toBeUndefined()
  })
})
