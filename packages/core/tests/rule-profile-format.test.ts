import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'

// The short rule and profile format (validate.ts, formatProblems): enforced on
// create and on updates that change content, trigger, applies or type; legacy
// entries stay patchable for everything else.
describe('rule and profile format', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'assistant' })
    eml.agents.store({ id: 'assistant', name: 'Assistant' })
  })
  afterEach(() => { eml.close() })

  const storeRule = (content: string, properties: Record<string, unknown>) =>
    eml.engrams.store({ type: 'rule', scope: 'global', title: 'r', content, properties })

  // A legacy entry as it sits in an existing brain (written before the format).
  const plantLegacy = (id: string, content: string, properties?: Record<string, unknown>) => {
    const db = (eml as any).db
    db.prepare('UPDATE engrams SET content = ? WHERE id = ?').run(content, id)
    if (properties) db.prepare('UPDATE engrams SET properties = ? WHERE id = ?').run(JSON.stringify(properties), id)
  }

  describe('create', () => {
    it('accepts a rule of 200 chars and rejects 201, pointing to why and detail', () => {
      expect(() => storeRule('x'.repeat(200), { applies: 'always' })).not.toThrow()
      expect(() => storeRule('x'.repeat(201), { applies: 'always' })).toThrow(
        "Invalid engram: a rule's content is at most 200 characters (got 201) — state only what to do. " +
        'Put the rationale in properties.why and playbook or examples in properties.detail.',
      )
    })

    it('requires a trigger of at most 80 chars on a situational rule', () => {
      expect(() => storeRule('do Y', { applies: 'situational' })).toThrow(
        "Invalid engram: a situational rule needs properties.trigger — the situation it applies in, at most 80 characters. Don't repeat it in content.",
      )
      expect(() => storeRule('do Y', { applies: 'situational', trigger: '  ' })).toThrow(/needs properties.trigger/)
      expect(() => storeRule('do Y', { applies: 'situational', trigger: 'x'.repeat(81) })).toThrow(
        'Invalid engram: properties.trigger is at most 80 characters (got 81).',
      )
      expect(() => storeRule('do Y', { applies: 'situational', trigger: 'x'.repeat(80) })).not.toThrow()
    })

    it('needs no trigger on an always-rule', () => {
      expect(() => storeRule('do Y', { applies: 'always' })).not.toThrow()
    })

    it('reports every problem in one error', () => {
      expect(() => storeRule('x'.repeat(250), { applies: 'situational' })).toThrow(
        /at most 200 characters \(got 250\).*properties\.detail\. A situational rule needs properties\.trigger/,
      )
    })

    it('accepts a profile of 400 chars and rejects 401', () => {
      const store = (content: string) => eml.engrams.store({ type: 'profile', scope: 'agent.assistant', title: 'p', content })
      expect(() => store('x'.repeat(400))).not.toThrow()
      expect(() => store('x'.repeat(401))).toThrow(
        "Invalid engram: a profile's content is at most 400 characters (got 401) — keep the core facts; put the rest in properties.detail or a separate profile.",
      )
    })

    it('leaves other types alone', () => {
      expect(() => eml.engrams.store({ type: 'note', scope: 'global', content: 'x'.repeat(5000) })).not.toThrow()
    })
  })

  describe('update of a legacy entry', () => {
    let id: string
    beforeEach(() => {
      id = storeRule('short', { applies: 'situational', trigger: 't' }).id
      plantLegacy(id, 'x'.repeat(600), { applies: 'situational' })
    })

    it('allows status, significance, title, tags and review changes', () => {
      expect(() => eml.engrams.update(id, { status: 'superseded' })).not.toThrow()
      expect(() => eml.engrams.update(id, { title: 'renamed', significance: 'high' })).not.toThrow()
      expect(() => eml.engrams.update(id, { properties: { review_due_at: '2027-01-01T00:00:00Z', why: 'because' } })).not.toThrow()
    })

    it('enforces the format when content, trigger or applies change', () => {
      expect(() => eml.engrams.update(id, { content: 'y'.repeat(300) })).toThrow(/at most 200 characters \(got 300\)/)
      expect(() => eml.engrams.update(id, { properties: { trigger: 'now' } })).toThrow(/at most 200 characters \(got 600\)/)
      expect(() => eml.engrams.update(id, { properties: { applies: 'always' } })).toThrow(/at most 200 characters/)
    })

    it('accepts a migration to the short format', () => {
      const r = eml.engrams.update(id, { content: 'Do Y.', properties: { trigger: 'when X happens', why: 'because', detail: 'x'.repeat(600) } })
      expect(r?.content).toBe('Do Y.')
    })

    it('enforces the format when another type becomes a rule or profile', () => {
      const note = eml.engrams.store({ type: 'note', scope: 'global', content: 'x'.repeat(500) })
      expect(() => eml.engrams.update(note.id, { type: 'profile' })).toThrow(/a profile's content is at most 400/)
    })

    it('applies to profiles the same way', () => {
      const p = eml.engrams.store({ type: 'profile', scope: 'agent.assistant', title: 'p', content: 'short' })
      plantLegacy(p.id, 'x'.repeat(700))
      expect(() => eml.engrams.update(p.id, { properties: { review_due_at: '2027-01-01T00:00:00Z' } })).not.toThrow()
      expect(() => eml.engrams.update(p.id, { content: 'x'.repeat(401) })).toThrow(/at most 400 characters \(got 401\)/)
    })
  })
})
