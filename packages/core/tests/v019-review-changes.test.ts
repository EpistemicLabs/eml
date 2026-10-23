import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, readObject, createObject, type Env } from '../src'
import { renderBrainStateMarkdown } from '../src/render'
import { validDecision, validLog, validRule } from './fixtures'
import { hygieneCheck } from '../src/hygiene'

// v0.19 — behaviour changes from the review of the agent-facing texts
// (note v0.19-agent-texts-decisions, C1–C6).

describe('v0.19 review changes', () => {
  let eml: EML
  const ctx = (session = 's1', caller = 'juno'): Env =>
    eml.env({ handle: caller, session_id: session, model: 'test-model', harness: 'claude-code', ingestion_method: 'mcp' })

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'juno' })
    eml.agents.store({ id: 'juno', name: 'Juno' })
    eml.users.create({ id: 'ada', name: 'Ada' })
    eml.projects.create({ id: 'p', name: 'P' })
  })
  afterEach(() => { eml.close() })

  describe('C1 eml_show: the last five logs, no decisions', () => {
    it('lists the five newest logs and no decisions section', () => {
      for (let i = 1; i <= 6; i++) {
        eml.engrams.store(validLog({ scope: 'project.p', title: `session-${i}`, properties: { what: `what ${i}`, landed: 'l', next: `next ${i}` } }), ctx(`s${i}`))
      }
      eml.engrams.store(validDecision({ scope: 'project.p', title: 'some-choice' }), ctx())
      const state = eml.engrams.buildBrainState('project.p')
      expect(state.recent_logs).toHaveLength(5)
      const md = renderBrainStateMarkdown(state)
      expect(md).toContain('## Recent sessions (last 5, newest first)')
      expect(md).toContain('next: next 6')
      expect(md).not.toContain('session-1 ')
      expect(md).not.toContain('## Decisions')
      expect(md).not.toContain('some-choice')
    })
  })

  describe('C2 eml_read_object: kind filter for entities', () => {
    it('lists entities of one kind; kind on another object or an unknown kind errors', () => {
      createObject(eml, 'entity', { name: 'Acme', kind: 'org' })
      createObject(eml, 'entity', { name: 'Bea', kind: 'person' })
      const orgs = readObject(eml, 'entity', { kind: 'org' }) as Array<{ id: string }>
      expect(orgs.map(e => e.id)).toEqual(['acme'])
      expect((readObject(eml, 'entity') as unknown[]).length).toBe(2)
      expect(() => readObject(eml, 'project', { kind: 'org' })).toThrow('Invalid object: kind filters entities only.')
      expect(() => readObject(eml, 'entity', { kind: 'team' })).toThrow('Invalid object: kind is one of person, org, asset.')
    })
  })

  describe('C3 learnings: out of eml_show, eml_list state filter', () => {
    it('finds ripe learnings by state; eml_show no longer lists them', () => {
      const a = eml.engrams.learn({ title: 'ask-before-push', content: 'Ask before pushing.', scope: 'user.ada', source: 'user', happened: 'pushed without asking', quote: 'ask first' }, ctx('s1'))
      expect(a.written).toBe(true)
      const id = (a as { engram: { id: string } }).engram.id
      expect(eml.engrams.query({ learning_state: 'collecting' }).map(e => e.id)).toEqual([id])
      expect(eml.engrams.query({ learning_state: 'ripe' })).toEqual([])
      eml.engrams.learn({ id, source: 'observed', happened: 'pushed again' }, ctx('s2'))
      expect(eml.engrams.query({ learning_state: 'ripe' }).map(e => e.id)).toEqual([id])
      expect(eml.engrams.query({ learning_state: 'ripe', scope: 'project.p' })).toEqual([])
      const state = eml.engrams.buildBrainState('user.ada') as unknown as Record<string, unknown>
      expect(state.ripe_learnings).toBeUndefined()
      expect(renderBrainStateMarkdown(eml.engrams.buildBrainState('user.ada'))).not.toContain('ask-before-push')
    })
  })

  describe('C4 default-brain seed rules wait for the user\'s agreement', () => {
    it('only a seed rule may be written without agreed; the hygiene check finds it', () => {
      const rule = validRule() as Record<string, any>
      const { agreed: _drop, ...props } = rule.properties
      expect(() => eml.engrams.store({ ...rule, properties: props } as any)).toThrow('a rule needs agreed.')
      const seed = eml.engrams.store({ ...rule, title: 'seed-rule', properties: props, origin: 'eml-default-brain' } as any)
      expect((seed.properties as any).agreed).toBeUndefined()
      const check = hygieneCheck(eml).checks.find(c => c.id === 'rule-without-agreement')!
      expect(check.findings.map(f => f.id)).toContain(seed.id)
    })
  })

  describe('C6 hygiene: who decides', () => {
    it('every check says who decides; only the rule agreement needs the user', () => {
      const checks = hygieneCheck(eml).checks
      expect(checks.every(c => c.decides === 'agent' || c.decides === 'user')).toBe(true)
      expect(checks.filter(c => c.decides === 'user').map(c => c.id)).toEqual(['rule-without-agreement', 'learning-unclear'])
    })
  })
})
