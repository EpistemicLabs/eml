import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, boot, ALL_RULES, type SystemRule } from '../src'
import { validDecision, validTask } from './fixtures'

describe('boot()', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'assistant' })
    eml.agents.store({ id: 'assistant', name: 'Assistant' })
    eml.agents.store({ id: 'atlas', name: 'Atlas' })
    eml.users.create({ id: 'alice', name: 'Alice' })
  })

  afterEach(() => {
    eml.close()
  })

  describe('empty brain', () => {
    it('returns header + footer with zero counts', () => {
      const result = boot(eml, 'assistant')
      expect(result.agent).toBe('assistant')
      expect(result.engrams).toBe(0)
      expect(result.open_tasks).toBe(0)
      expect(result.recent_logs).toBe(0)
      expect(result.stale_status).toBe(0)
      expect(result.overdue_review).toBe(0)
      expect(result.markdown).toContain('# EML Boot — assistant')
      expect(result.version).toBeUndefined()
    })
  })

  describe('boot-tag filter', () => {
    it('includes engrams tagged for the agent', () => {
      eml.engrams.store({
        type: 'profile', scope: 'global', content: 'I am assistant',
        properties: { boot: ['assistant'] },
      })
      const result = boot(eml, 'assistant')
      expect(result.engrams).toBe(1)
      expect(result.markdown).toMatch(/## Identity[\s\S]*I am assistant/)
    })

    it('excludes engrams without boot property', () => {
      eml.engrams.store({ type: 'profile', scope: 'global', content: 'untagged' })
      const result = boot(eml, 'assistant')
      expect(result.engrams).toBe(0)
    })

    it('excludes engrams tagged only for other agents', () => {
      eml.engrams.store({
        type: 'profile', scope: 'global', content: 'foreign',
        properties: { boot: ['atlas'] },
      })
      const result = boot(eml, 'assistant')
      expect(result.engrams).toBe(0)
    })

    it('wildcard boot=["*"] matches every agent', () => {
      eml.engrams.store({
        type: 'profile', scope: 'global', content: 'universal',
        properties: { boot: ['*'] },
      })
      expect(boot(eml, 'assistant').engrams).toBe(1)
      expect(boot(eml, 'atlas').engrams).toBe(1)
    })
  })

  describe('slim type rendering (v0.10.1)', () => {
    it('renders only profile (Identity) + rule (Behavior); other boot-tagged types are skipped', () => {
      const types = ['reference', 'log', 'event', 'task', 'status', 'decision', 'rule', 'profile']
      for (const t of types) {
        const props: Record<string, unknown> = { boot: ['*'] }
        if (t === 'rule') props.applies = 'situational'
        if (t === 'status') props.state = 'running'
        if (t === 'decision') { props.rationale = 'test rationale'; props.alternatives = ['test alternative'] }
        if (t === 'event') { props.occurred_at = '2026-05-15T00:00:00Z'; props.change_type = 'deployed' }
        const status = t === 'task' ? 'active' : undefined
        eml.engrams.store({ type: t as any, scope: 'global', content: `${t}-content`, properties: props, status })
      }
      const md = boot(eml, 'assistant').markdown
      expect(md).toContain('## Identity')
      expect(md).toContain('## Behavior')
      expect(md).not.toContain('## Decisions')
      expect(md).not.toContain('## Tasks')
      expect(md).not.toContain('## Events')
      expect(md).not.toContain('## Logs')
      expect(md).not.toContain('## References')
      expect(md).not.toMatch(/^## Status$/m)
      // Identity comes before Behavior
      expect(md.indexOf('## Identity')).toBeLessThan(md.indexOf('## Behavior'))
    })

    it('does not render the ## Open Tasks section; counter still populated', () => {
      eml.engrams.store({ type: 'task', scope: 'global', content: 'planned-task' })
      eml.engrams.store({ type: 'task', scope: 'global', content: 'active-task', status: 'active' })
      eml.engrams.store(validTask({ scope: 'global', content: 'resolved-task', status: 'resolved' }))
      const result = boot(eml, 'assistant')
      expect(result.open_tasks).toBe(2)
      expect(result.markdown).not.toContain('## Open Tasks')
      expect(result.markdown).not.toContain('planned-task')
      expect(result.markdown).not.toContain('active-task')
    })

    it('does not render the ## Recent Logs section; counter still populated', () => {
      eml.engrams.store({ type: 'log', scope: 'global', content: 'session-summary-1' })
      const result = boot(eml, 'assistant')
      expect(result.recent_logs).toBe(1)
      expect(result.markdown).not.toContain('## Recent Logs')
      expect(result.markdown).not.toContain('session-summary-1')
    })

    it('does not render properties-trailer lines under engrams', () => {
      eml.engrams.store({
        type: 'profile', scope: 'global', content: 'I am assistant',
        properties: { boot: ['*'], source_id: 'assistant', source_type: 'agent', review_due_at: '2026-10-14' },
      })
      const md = boot(eml, 'assistant').markdown
      expect(md).not.toContain('_source_id:')
      expect(md).not.toContain('review_due_at:')
    })
  })

  describe('stale status (deferred to v0.11)', () => {
    it('does not render the ## Status Review needed section; counter still populated', () => {
      eml.engrams.store({
        type: 'status', scope: 'global', title: 'will-be-stale', content: 'long status body',
        properties: { state: 'running' },
      })
      const result = boot(eml, 'assistant', { reviewDays: -1 })
      expect(result.stale_status).toBe(1)
      expect(result.markdown).not.toContain('## Status Review needed')
      expect(result.markdown).not.toContain('long status body')
    })

    it('counter is zero when no active status is stale', () => {
      eml.engrams.store({
        type: 'status', scope: 'global', content: 'fresh',
        properties: { state: 'running' },
      })
      const result = boot(eml, 'assistant', { reviewDays: 1000 })
      expect(result.stale_status).toBe(0)
      expect(result.markdown).not.toContain('## Status Review needed')
    })
  })

  describe('overdue review (deferred to v0.11)', () => {
    it('does not render the ## Review needed (overdue) section; counter still populated', () => {
      eml.engrams.store(validDecision({
        scope: 'global', title: 'old-decision',
        content: 'we picked X',
        properties: { review_due_at: '2020-01-01T00:00:00Z' },
      }))
      const result = boot(eml, 'assistant')
      expect(result.overdue_review).toBe(1)
      expect(result.markdown).not.toContain('## Review needed')
    })

    it('counter ignores types other than decision/rule/profile even with overdue review_due_at', () => {
      eml.engrams.store({
        type: 'task', scope: 'global', content: 'task-with-due',
        properties: { review_due_at: '2020-01-01T00:00:00Z' },
      })
      expect(boot(eml, 'assistant').overdue_review).toBe(0)
    })
  })

  describe('rule content trimmer (v0.10.1)', () => {
    it('caps rule content at 600 chars with … suffix', () => {
      const longBody = 'x'.repeat(800)
      eml.engrams.store({
        type: 'rule', scope: 'global', title: 'too-long',
        content: longBody,
        properties: { boot: ['*'], applies: 'situational' },
      })
      const md = boot(eml, 'assistant').markdown
      expect(md).toContain('x'.repeat(600) + '…')
      expect(md).not.toContain('x'.repeat(601))
    })

    it('leaves rule content under 600 chars untouched', () => {
      eml.engrams.store({
        type: 'rule', scope: 'global', title: 'short',
        content: 'A short rule body, well under the cap.',
        properties: { boot: ['*'], applies: 'situational' },
      })
      const md = boot(eml, 'assistant').markdown
      expect(md).toContain('A short rule body, well under the cap.')
      expect(md).not.toContain('…')
    })

    it('does NOT cap profile content (identity stays full)', () => {
      const longBody = 'y'.repeat(800)
      eml.engrams.store({
        type: 'profile', scope: 'agent.assistant', title: 'assistant',
        content: longBody,
        properties: { boot: ['*'] },
      })
      const md = boot(eml, 'assistant').markdown
      expect(md).toContain('y'.repeat(800))
      expect(md).not.toContain('y'.repeat(799) + '…')
    })
  })

  describe('opts.systemRules — EML System Rules section (v0.10.1)', () => {
    it('renders "## EML System Rules" section BELOW Identity when systemRules non-empty', () => {
      eml.engrams.store({
        type: 'profile', scope: 'global', content: 'identity',
        properties: { boot: ['*'] },
      })
      const rules: SystemRule[] = [
        { category: 'behavior', text: 'be helpful' },
        { category: 'sot-hierarchy', text: 'brain is canonical' },
      ]
      const md = boot(eml, 'assistant', { systemRules: rules }).markdown
      expect(md).toContain('## EML System Rules (managed by engramprotocol)')
      expect(md).toContain('- [behavior] be helpful')
      expect(md).toContain('- [sot-hierarchy] brain is canonical')
      // Identity comes BEFORE EML System Rules now (was reversed in v0.10.0)
      expect(md.indexOf('## Identity')).toBeLessThan(md.indexOf('## EML System Rules'))
    })

    it('omits the section entirely when systemRules is empty', () => {
      const md = boot(eml, 'assistant', { systemRules: [] }).markdown
      expect(md).not.toContain('## EML System Rules')
    })
  })

  describe('opts.version (v0.10.0)', () => {
    it('includes version in BootResult when provided', () => {
      const result = boot(eml, 'assistant', { version: '0.10.1' })
      expect(result.version).toBe('0.10.1')
    })

    it('omits version from BootResult when not provided', () => {
      const result = boot(eml, 'assistant')
      expect(result.version).toBeUndefined()
    })

    it('appends version tag to the EML System Rules section header', () => {
      const rules: SystemRule[] = [{ category: 'test', text: 'x' }]
      const md = boot(eml, 'assistant', { systemRules: rules, version: '0.10.1' }).markdown
      expect(md).toContain('## EML System Rules (managed by engramprotocol v0.10.1)')
    })
  })

  describe('footer hint (v0.10.1)', () => {
    it('always appends the recall-hint footer with separator', () => {
      const md = boot(eml, 'assistant').markdown
      expect(md).toContain('---')
      expect(md).toContain('_For decisions, statuses, open tasks, logs, project-specific rules: call eml_recall <topic> or eml_show <id>._')
    })
  })

  describe('section ordering (v0.10.1)', () => {
    it('renders sections in canonical order: Identity → Behavior → EML System Rules → Footer', () => {
      eml.engrams.store({
        type: 'profile', scope: 'agent.assistant', title: 'assistant',
        content: 'identity',
        properties: { boot: ['*'] },
      })
      eml.engrams.store({
        type: 'rule', scope: 'agent.assistant', title: 'plan-first',
        content: 'discuss plan first',
        properties: { boot: ['*'], applies: 'situational' },
      })
      const rules: SystemRule[] = [{ category: 'behavior', text: 'be helpful' }]
      const md = boot(eml, 'assistant', { systemRules: rules, version: '0.10.1' }).markdown
      const idx = (s: string) => md.indexOf(s)
      expect(idx('## Identity')).toBeGreaterThan(-1)
      expect(idx('## Behavior')).toBeGreaterThan(idx('## Identity'))
      expect(idx('## EML System Rules')).toBeGreaterThan(idx('## Behavior'))
      expect(idx('---')).toBeGreaterThan(idx('## EML System Rules'))
    })
  })

  describe('size budget (v0.10.1)', () => {
    it('keeps markdown under 9000 bytes on a realistic-brain fixture', () => {
      // 4 profiles (identity)
      eml.engrams.store({
        type: 'profile', scope: 'agent.assistant', title: 'assistant',
        content: 'Assistant — a digital moth. Lead-dev and strategic partner for Alice\'s projects.',
        properties: { boot: ['assistant'] },
      })
      for (let i = 0; i < 3; i++) {
        eml.engrams.store({
          type: 'profile', scope: 'user.alice', title: `alice-${i}`,
          content: 'Alice profile facet. ' + 'Lorem ipsum dolor sit amet. '.repeat(4),
          properties: { boot: ['assistant'] },
        })
      }
      // 7 boot-tagged rules (behavior)
      for (let i = 0; i < 7; i++) {
        eml.engrams.store({
          type: 'rule', scope: i < 3 ? 'global' : 'agent.assistant', title: `rule-${i}`,
          content: `Rule ${i} imperative line. ` + 'More context, but kept short. '.repeat(5),
          properties: { boot: ['assistant'], applies: 'situational' },
        })
      }
      // Non-boot engrams that should NOT bloat the output
      for (let i = 0; i < 5; i++) {
        eml.engrams.store({
          type: 'status', scope: 'global', title: `s-${i}`,
          content: 'Long status body. '.repeat(50),
          properties: { state: 'running' },
        })
      }
      for (let i = 0; i < 5; i++) {
        eml.engrams.store({
          type: 'task', scope: 'global', title: `t-${i}`,
          content: 'Long task body. '.repeat(50),
          status: 'active',
          properties: { priority: 'high' },
        })
      }
      // Real SYSTEM_RULES (16) + BEHAVIOR_DEFAULTS (2) = 18 rules
      const md = boot(eml, 'assistant', { systemRules: ALL_RULES, version: '0.10.1' }).markdown
      expect(md.length).toBeLessThan(9000)
    })
  })
})
