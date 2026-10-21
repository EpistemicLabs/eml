import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, validateFields } from '../src'
import { validDecision } from './fixtures'

// A decision is a choice between real alternatives, with a rationale (v0.15).
// v0.19: the requirement lives in the field model (fields.ts) — core rejects a
// NEW decision without at least one alternative or without a rationale, so MCP,
// HTTP and CLI all hit it. Legacy decisions written without them stay patchable
// and supersedable. All errors start with `Invalid engram:`.

describe('decision validation', () => {
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
       VALUES (?, 'decision', 'project.eml', ?, 'legacy choice', '{"detail":"decision_type: architectural"}')`,
    ).run(id, title)
    rawDb().prepare(
      `INSERT INTO engrams_fts (id, content, scope, title) VALUES (?, 'legacy choice', 'project.eml', ?)`,
    ).run(id, title)
  }

  describe('on create', () => {
    it('rejects a decision without alternatives, naming only what is missing', () => {
      expect(() => eml.engrams.store({
        type: 'decision', scope: 'project.eml', title: 'use-sqlite', content: 'use sqlite',
        properties: { rationale: 'one file, no server' },
      })).toThrow('Invalid engram: a decision needs alternatives.')
      expect(count()).toBe(0)
    })

    it('rejects a decision without a rationale', () => {
      let msg = ''
      try {
        eml.engrams.store({
          type: 'decision', scope: 'project.eml', title: 'use-sqlite', content: 'use sqlite',
          properties: { alternatives: ['postgres'] },
        })
      } catch (e) { msg = (e as Error).message }
      expect(msg).toBe('Invalid engram: a decision needs rationale.')
      expect(count()).toBe(0)
    })

    it('names both when both are missing', () => {
      expect(() => eml.engrams.store({ type: 'decision', scope: 'project.eml', title: 'use-sqlite', content: 'use sqlite' }))
        .toThrow('Invalid engram: a decision needs rationale. a decision needs alternatives.')
    })

    it('needs a title (the recall anchor)', () => {
      expect(() => eml.engrams.store(validDecision({ title: undefined })))
        .toThrow('Invalid engram: a decision needs a title')
    })

    it('treats an empty list, blank alternatives and a blank rationale as missing', () => {
      expect(() => eml.engrams.store(validDecision({ properties: { alternatives: [] } })))
        .toThrow(/alternatives must not be empty/)
      expect(() => eml.engrams.store(validDecision({ properties: { alternatives: ['  ', ''] } })))
        .toThrow(/alternatives must not be empty/)
      expect(() => eml.engrams.store(validDecision({ properties: { rationale: '   ' } })))
        .toThrow(/rationale must not be empty/)
      expect(count()).toBe(0)
    })

    it('rejects a status on create — a new decision is active', () => {
      expect(() => eml.engrams.store(validDecision({ status: 'planned' })))
        .toThrow('Invalid engram: status is not set on create — a new decision is active.')
    })

    it('accepts a decision with one alternative and a rationale', () => {
      const d = eml.engrams.store({
        type: 'decision', scope: 'project.eml', title: 'use-sqlite', content: 'use sqlite',
        properties: { rationale: 'one file, no server', alternatives: ['postgres'] },
      })
      expect(d.type).toBe('decision')
      expect(d.status).toBe('active')
      expect(d.significance).toBe('normal')
    })
  })

  describe('legacy decisions (written before v0.15)', () => {
    it('stay patchable: content, fields and status', () => {
      legacyDecision('legacy-1', 'old-choice')
      expect(eml.engrams.update('legacy-1', { content: 'legacy choice, reworded' })!.content)
        .toBe('legacy choice, reworded')
      expect(eml.engrams.update('legacy-1', { properties: { review_due_at: '2027-01-01T00:00:00.000Z' } }))
        .toBeTruthy()
      expect(eml.engrams.update('legacy-1', { status: 'invalidated' })!.status).toBe('invalidated')
    })

    it('stay supersedable by a new engram (supersedes)', () => {
      legacyDecision('legacy-2', 'old-choice')
      const next = eml.engrams.store(validDecision({
        scope: 'project.eml', title: 'old-choice', content: 'the new choice', supersedes: ['legacy-2'],
      }))
      expect(eml.engrams.get('legacy-2')!.status).toBe('superseded')
      expect(next.status).toBe('active')
      expect(next.superseded).toEqual(['legacy-2'])
    })

    it('validateFields in update mode does not demand alternatives/rationale', () => {
      expect(() => validateFields('decision', {}, 'update')).not.toThrow()
      expect(() => validateFields('decision', {}, 'create')).toThrow(/^Invalid engram:/)
      expect(() => validateFields('decision', { rationale: null }, 'update')).toThrow(/cannot be cleared/)
    })
  })
})
