import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'

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
  const labels = (id: string) => eml.engrams.getRaw(id)!.labels
  const makeDue = (id: string) => {
    const db = (eml as any).db
    const props = JSON.parse(db.prepare('SELECT properties FROM engrams WHERE id = ?').get(id).properties)
    db.prepare('UPDATE engrams SET properties = ? WHERE id = ?').run(JSON.stringify({ ...props, review_due_at: '2020-01-01T00:00:00.000Z' }), id)
    eml.engrams.stampDueReviewLabels()
    expect(labels(id)).toContain('review')
  }

  it('restarts on a content change: review_due_at moves forward, the review label goes', () => {
    const r = eml.engrams.store({ type: 'rule', scope: 'global', title: 'r', content: 'do Y', properties: { applies: 'always' } })
    makeDue(r.id)
    eml.engrams.update(r.id, { content: 'do Z' })
    expect(Date.parse(due(r.id))).toBeGreaterThan(Date.now() + 80 * 86400_000)
    expect(labels(r.id)).not.toContain('review')
  })

  it('restarts on a properties change — a review_note confirms without a change — or a title change', () => {
    const r = eml.engrams.store({ type: 'rule', scope: 'global', title: 'r', content: 'do Y', properties: { applies: 'always' } })
    makeDue(r.id)
    eml.engrams.update(r.id, { properties: { review_note: 'still holds' } })
    expect(Date.parse(due(r.id))).toBeGreaterThan(Date.now())
    expect(labels(r.id)).not.toContain('review')
    makeDue(r.id)
    eml.engrams.update(r.id, { title: 'r2' })
    expect(labels(r.id)).not.toContain('review')
  })

  it('does not restart on significance, tags or an unchanged content', () => {
    const r = eml.engrams.store({ type: 'rule', scope: 'global', title: 'r', content: 'do Y', properties: { applies: 'always' } })
    makeDue(r.id)
    eml.engrams.update(r.id, { significance: 'high' })
    eml.engrams.update(r.id, { content: 'do Y' })
    expect(due(r.id)).toBe('2020-01-01T00:00:00.000Z')
    expect(labels(r.id)).toContain('review')
  })

  it('keeps an explicit review_due_at from the patch, and still clears the review label', () => {
    const r = eml.engrams.store({ type: 'rule', scope: 'global', title: 'r', content: 'do Y', properties: { applies: 'always' } })
    makeDue(r.id)
    eml.engrams.update(r.id, { content: 'do Z', properties: { review_due_at: '2030-05-05T00:00:00.000Z' } })
    expect(due(r.id)).toBe('2030-05-05T00:00:00.000Z')
    expect(labels(r.id)).not.toContain('review')
  })

  it('treats review_due_at: null in a substantive patch as not given: the cycle restarts', () => {
    const r = eml.engrams.store({ type: 'rule', scope: 'global', title: 'r', content: 'do Y', properties: { applies: 'always' } })
    makeDue(r.id)
    eml.engrams.update(r.id, { content: 'do Z', properties: { review_due_at: null } })
    expect(Date.parse(due(r.id))).toBeGreaterThan(Date.now() + 80 * 86400_000)
    expect(labels(r.id)).not.toContain('review')
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
    const r = eml.engrams.store({ type: 'rule', scope: 'global', title: 'r', content: 'do Y', properties: { applies: 'always' } })
    makeDue(r.id)
    eml.engrams.update(r.id, { content: 'do Z', status: 'superseded' })
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
