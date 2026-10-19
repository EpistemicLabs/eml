import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, hygieneCheck, HYGIENE_CHECKS, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'

// The brain-hygiene check (hygiene.ts).
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

  it('lists every check with what and how, also without findings; migration checks name their schema', () => {
    const r = hygieneCheck(eml)
    expect(r.total).toBe(0)
    expect(r.schema).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
    expect(r.checks.map(c => c.id)).toEqual(HYGIENE_CHECKS.map(c => c.id))
    for (const c of r.checks) {
      expect(c.what.length).toBeGreaterThan(0)
      expect(c.how.length).toBeGreaterThan(0)
      if (c.kind === 'migration') expect(Number.isInteger(c.since_schema)).toBe(true)
      else expect(c.since_schema).toBeUndefined()
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

    it('reads a due date without a zone as UTC, as the nightly sweep does', () => {
      const now = new Date('2026-10-19T12:00:00.000Z')
      const soon = rule('global', 'due-in-30-min')
      plant(soon.id, null, { applies: 'always', review_due_at: '2026-10-19 12:30:00' })
      const isoSoon = rule('global', 'iso-due-in-30-min')
      plant(isoSoon.id, null, { applies: 'always', review_due_at: '2026-10-19T12:30' })
      const past = rule('global', 'due-30-min-ago')
      plant(past.id, null, { applies: 'always', review_due_at: '2026-10-19 11:30:00' })
      expect(check('review-due', now).findings.map(f => f.title)).toEqual(['due-30-min-ago'])
    })

    it('leaves tasks out, even when the sweep flagged them', () => {
      const task = eml.engrams.store({ type: 'task', scope: 'project.demo', title: 'idle', content: 'x' })
      ;(eml as any).db.prepare(`UPDATE engrams SET updated_at = datetime('now', '-60 days') WHERE id = ?`).run(task.id)
      eml.engrams.stampDueReviewLabels()
      expect(check('review-due').findings).toEqual([])
    })

    it('ignores entries that are no longer active', () => {
      const old = rule('global', 'old-due')
      plant(old.id, null, { applies: 'always', review_due_at: '2020-01-01T00:00:00.000Z' })
      eml.engrams.update(old.id, { status: 'invalidated' })
      expect(check('review-due').findings).toEqual([])
    })
  })
})
