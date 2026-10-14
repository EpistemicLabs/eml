import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, validateProperties } from '../src'
import { validDecision } from './fixtures'

// v0.15 Cluster A — a decision is a choice between real alternatives, with a
// rationale. Core rejects a NEW decision without at least one alternative or
// without a rationale (so MCP, HTTP and CLI all hit it). The check fires on
// create only: legacy decisions written without them stay patchable and
// supersedable (spec decision 10). All errors start with `Invalid engram:`.

describe('decision validation (v0.15)', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    eml.projects.create({ id: 'eml', name: 'EML' })
  })

  afterEach(() => eml.close())

  const rawDb = (): any => (eml.engrams as any).db
  const count = (): number =>
    (rawDb().prepare(`SELECT COUNT(*) AS n FROM engrams WHERE type = 'decision'`).get() as { n: number }).n

  /** A decision as written before v0.15: no alternatives, no rationale. */
  function legacyDecision(id: string, title: string): void {
    rawDb().prepare(
      `INSERT INTO engrams (id, type, scope, title, content, properties)
       VALUES (?, 'decision', 'project.eml', ?, 'legacy choice', '{"decision_type":"architectural"}')`,
    ).run(id, title)
    rawDb().prepare(
      `INSERT INTO engrams_fts (id, content, scope, title) VALUES (?, 'legacy choice', 'project.eml', ?)`,
    ).run(id, title)
  }

  describe('on create', () => {
    it('rejects a decision without alternatives, naming only what is missing', () => {
      expect(() => eml.engrams.store({
        type: 'decision', scope: 'project.eml', content: 'use sqlite',
        properties: { rationale: 'one file, no server' },
      })).toThrow('Invalid engram: a decision needs at least one alternative that was considered and rejected.')
      expect(count()).toBe(0)
    })

    it('rejects a decision without a rationale', () => {
      let msg = ''
      try {
        eml.engrams.store({
          type: 'decision', scope: 'project.eml', content: 'use sqlite',
          properties: { alternatives: ['postgres'] },
        })
      } catch (e) { msg = (e as Error).message }
      expect(msg).toBe('Invalid engram: a decision needs a rationale — why this option won.')
      expect(count()).toBe(0)
    })

    it('names both when both are missing', () => {
      expect(() => eml.engrams.store({ type: 'decision', scope: 'project.eml', content: 'use sqlite' }))
        .toThrow('Invalid engram: a decision needs at least one alternative that was considered and rejected. ' +
          'A decision needs a rationale — why this option won.')
    })

    it('does not point to other types', () => {
      let msg = ''
      try { eml.engrams.store({ type: 'decision', scope: 'global', content: 'x' }) } catch (e) { msg = (e as Error).message }
      expect(msg).not.toMatch(/\b(note|rule|status|task)\b/)
    })

    it('treats an empty list, blank alternatives and a blank rationale as missing', () => {
      expect(() => eml.engrams.store(validDecision({ properties: { alternatives: [] } })))
        .toThrow(/at least one alternative/)
      expect(() => eml.engrams.store(validDecision({ properties: { alternatives: ['  ', ''] } })))
        .toThrow(/at least one alternative/)
      expect(() => eml.engrams.store(validDecision({ properties: { rationale: '   ' } })))
        .toThrow(/needs a rationale/)
      expect(count()).toBe(0)
    })

    it('accepts a decision with one alternative and a rationale', () => {
      const d = eml.engrams.store({
        type: 'decision', scope: 'project.eml', content: 'use sqlite',
        properties: { rationale: 'one file, no server', alternatives: ['postgres'] },
      })
      expect(d.type).toBe('decision')
      expect(d.status).toBe('active')
    })
  })

  describe('legacy decisions (written before v0.15)', () => {
    it('stay patchable: content, properties and status', () => {
      legacyDecision('legacy-1', 'old-choice')
      expect(eml.engrams.update('legacy-1', { content: 'legacy choice, reworded' })!.content)
        .toBe('legacy choice, reworded')
      expect(eml.engrams.update('legacy-1', { properties: { review_due_at: '2027-01-01T00:00:00.000Z' } }))
        .toBeTruthy()
      expect(eml.engrams.update('legacy-1', { significance: 'low' })!.significance).toBe('low')
      expect(eml.engrams.update('legacy-1', { status: 'superseded' })!.status).toBe('superseded')
    })

    it('stay supersedable by a new engram (properties.supersedes)', () => {
      legacyDecision('legacy-2', 'old-choice')
      const next = eml.engrams.store(validDecision({
        scope: 'project.eml', title: 'old-choice', content: 'the new choice',
        properties: { supersedes: ['legacy-2'] },
      }))
      expect(eml.engrams.get('legacy-2')!.status).toBe('superseded')
      expect(next.status).toBe('active')
    })

    it('validateProperties without create does not demand alternatives/rationale', () => {
      expect(() => validateProperties('decision', {})).not.toThrow()
      expect(() => validateProperties('decision', {}, 'active', { create: false, prevStatus: 'active' })).not.toThrow()
      expect(() => validateProperties('decision', {}, 'active', { create: true })).toThrow(/^Invalid engram:/)
    })
  })
})
