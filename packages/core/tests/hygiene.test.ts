import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, hygieneCheck, HYGIENE_CHECKS } from '../src'

// The brain-hygiene check (hygiene.ts) and the review cycle it relies on.
describe('hygieneCheck()', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'assistant' })
    eml.agents.store({ id: 'assistant', name: 'Assistant' })
    eml.projects.create({ id: 'demo', name: 'Demo' })
  })
  afterEach(() => { eml.close() })

  // A legacy entry as it sits in an existing brain (written before the format).
  const plant = (id: string, content: string | null, properties?: Record<string, unknown>) => {
    const db = (eml as any).db
    if (content !== null) db.prepare('UPDATE engrams SET content = ? WHERE id = ?').run(content, id)
    if (properties) db.prepare('UPDATE engrams SET properties = ? WHERE id = ?').run(JSON.stringify(properties), id)
  }
  const check = (id: string, now?: Date) => hygieneCheck(eml, { now }).checks.find(c => c.id === id)!
  const rule = (scope: string, title: string, properties: Record<string, unknown> = { applies: 'always' }) =>
    eml.engrams.store({ type: 'rule', scope, title, content: 'do Y', properties })

  it('lists every check with what, how and since, also without findings', () => {
    const r = hygieneCheck(eml)
    expect(r.total).toBe(0)
    expect(r.checks.map(c => c.id)).toEqual(HYGIENE_CHECKS.map(c => c.id))
    for (const c of r.checks) {
      expect(c.what.length).toBeGreaterThan(0)
      expect(c.how.length).toBeGreaterThan(0)
      expect(c.since).toMatch(/^\d+\.\d+\.\d+$/)
      expect(c.findings).toEqual([])
    }
  })

  describe('rule-profile-format', () => {
    it('finds legacy rules and profiles in every scope, with the format problem as reason', () => {
      const long = rule('project.demo', 'long-one')
      plant(long.id, 'x'.repeat(250))
      const noTrigger = rule('global', 'no-trigger')
      plant(noTrigger.id, null, { applies: 'situational' })
      const profile = eml.engrams.store({ type: 'profile', scope: 'agent.assistant', title: 'assistant', content: 'short' })
      plant(profile.id, 'p'.repeat(500))
      rule('global', 'fine')

      const c = check('rule-profile-format')
      expect(c.kind).toBe('migration')
      const byId = Object.fromEntries(c.findings.map(f => [f.id, f]))
      expect(Object.keys(byId).sort()).toEqual([long.id, noTrigger.id, profile.id].sort())
      expect(byId[long.id]).toMatchObject({ type: 'rule', scope: 'project.demo', title: 'long-one' })
      expect(byId[long.id].reason).toMatch(/at most 200 characters \(got 250\)/)
      expect(byId[noTrigger.id].reason).toMatch(/needs properties\.trigger/)
      const both = rule('global', 'both')
      plant(both.id, 'x'.repeat(250), { applies: 'situational' })
      expect(check('rule-profile-format').findings.find(f => f.id === both.id)!.reason).toMatch(/properties\.detail\. A situational rule needs/)
      expect(byId[profile.id].reason).toMatch(/at most 400 characters \(got 500\)/)
    })

    it('ignores entries that are no longer active', () => {
      const old = rule('global', 'old')
      plant(old.id, 'x'.repeat(250))
      eml.engrams.update(old.id, { status: 'superseded' })
      expect(check('rule-profile-format').findings).toEqual([])
    })
  })

  describe('review-due', () => {
    it('finds active decisions, rules and profiles past review_due_at, in both stored date formats', () => {
      const iso = rule('global', 'iso-due')
      plant(iso.id, null, { applies: 'always', review_due_at: '2020-01-01T00:00:00.000Z' })
      const backfilled = rule('global', 'backfilled-due')
      plant(backfilled.id, null, { applies: 'always', review_due_at: '2020-02-01 12:00:00' })
      rule('global', 'not-due')

      const c = check('review-due')
      expect(c.kind).toBe('review')
      expect(c.findings.map(f => f.title).sort()).toEqual(['backfilled-due', 'iso-due'])
      expect(c.findings.find(f => f.title === 'backfilled-due')!.reason).toBe('review due since 2020-02-01.')
    })

    it('finds open tasks the sweep flagged for inactivity', () => {
      const task = eml.engrams.store({ type: 'task', scope: 'project.demo', title: 'idle', content: 'x' })
      ;(eml as any).db.prepare(`UPDATE engrams SET updated_at = datetime('now', '-60 days') WHERE id = ?`).run(task.id)
      eml.engrams.stampDueReviewLabels()
      const c = check('review-due')
      expect(c.findings).toEqual([
        { id: task.id, type: 'task', scope: 'project.demo', title: 'idle', reason: 'open task without movement for 30+ days.' },
      ])
    })
  })
})

// A substantive edit of an active decision/rule/profile restarts its review cycle.
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

  it('keeps an explicit review_due_at from the patch', () => {
    const r = eml.engrams.store({ type: 'rule', scope: 'global', title: 'r', content: 'do Y', properties: { applies: 'always' } })
    eml.engrams.update(r.id, { content: 'do Z', properties: { review_due_at: '2030-05-05T00:00:00.000Z' } })
    expect(due(r.id)).toBe('2030-05-05T00:00:00.000Z')
  })

  it('leaves types without a review date alone', () => {
    const n = eml.engrams.store({ type: 'note', scope: 'global', title: 'n', content: 'a' })
    eml.engrams.update(n.id, { content: 'b' })
    expect(eml.engrams.getRaw(n.id)!.properties?.review_due_at).toBeUndefined()
  })
})
