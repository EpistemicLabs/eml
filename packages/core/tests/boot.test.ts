import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, boot, ALL_RULES, type SystemRule } from '../src'
import {
  validDecision, validTask, validNote, validStatus, validLog, closedTask, writes,
} from './fixtures'

// Legacy entries (written before the short format) cannot be stored through
// the store any more; tests plant them with a raw UPDATE, the way they sit in
// an existing brain.
function makeLegacy(eml: EML, id: string, content: string, properties?: Record<string, unknown>): void {
  const db = (eml as any).db
  db.prepare('UPDATE engrams SET content = ? WHERE id = ?').run(content, id)
  if (properties) db.prepare('UPDATE engrams SET properties = ? WHERE id = ?').run(JSON.stringify(properties), id)
}

describe('boot()', () => {
  let eml: EML

  const rule = (scope: string, title: string, applies: 'always' | 'situational', content = `${title} body`, trigger?: string) =>
    writes(eml).store({
      type: 'rule', scope, title, content,
      properties: { applies, why: 'test why', agreed: 'yes', ...(applies === 'situational' && { trigger: trigger ?? `${title} situation` }) },
    })
  // v0.19: the identity is the profile marked core (one per scope), not a title.
  const profile = (scope: string, title: string, content = `${title} facts`, core = true) =>
    writes(eml).store({ type: 'profile', scope, title, content, properties: core ? { core: true } : {} })

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'assistant' })
    writes(eml).agents.store({ id: 'assistant', name: 'Assistant' })
    writes(eml).agents.store({ id: 'atlas', name: 'Atlas' })
    writes(eml).users.create({ id: 'alice', name: 'Alice' })
    writes(eml).projects.create({ id: 'demo', name: 'Demo' })
  })

  afterEach(() => {
    eml.close()
  })

  describe('empty brain', () => {
    it('returns the header alone with zero counts', () => {
      const result = boot(eml, 'assistant')
      expect(result.agent).toBe('assistant')
      expect(result.engrams).toBe(0)
      expect(result.legacy).toBe(0)
      expect(result.open_tasks).toBe(0)
      expect(result.recent_logs).toBe(0)
      expect(result.stale_status).toBe(0)
      expect(result.overdue_review).toBe(0)
      expect(result.markdown).toBe('# EML Boot — assistant')
      expect(result.version).toBeUndefined()
    })
  })

  describe('selection by scope', () => {
    it('boots the rules of global, agent.<self> and user.<self>', () => {
      rule('global', 'g-rule', 'always')
      rule('agent.assistant', 'a-rule', 'always')
      rule('user.alice', 'u-rule', 'situational')
      const r = boot(eml, 'assistant')
      expect(r.engrams).toBe(3)
      expect(r.markdown).toContain('g-rule body')
      expect(r.markdown).toContain('a-rule body')
      expect(r.markdown).toContain('when: u-rule situation')
    })

    it('leaves out project rules, other agents\' rules and non-active rules', () => {
      rule('project.demo', 'p-rule', 'always')
      rule('agent.atlas', 'atlas-rule', 'always')
      const old = rule('global', 'old-rule', 'always', 'old')
      writes(eml).update(old.id, { status: 'invalidated' })
      const r = boot(eml, 'assistant')
      expect(r.engrams).toBe(0)
      expect(r.markdown).not.toContain('p-rule')
      expect(r.markdown).not.toContain('atlas-rule')
      expect(r.markdown).not.toContain('old-rule')
    })

    it('ignores properties.boot: a flagged project rule stays out, an unflagged global rule boots', () => {
      // A legacy row still carrying the flag (planted raw: boot is no field since v0.19).
      const flagged = rule('project.demo', 'flagged', 'always', 'flagged')
      makeLegacy(eml, flagged.id, 'flagged', { applies: 'always', why: 'w', agreed: 'yes', boot: ['*'] })
      rule('global', 'unflagged', 'always')
      const md = boot(eml, 'assistant').markdown
      expect(md).not.toContain('[project.demo | flagged]')
      expect(md).toContain('unflagged body')
    })

    it('opts.user narrows user.<self> to that user', () => {
      writes(eml).users.create({ id: 'bob', name: 'Bob' })
      rule('user.alice', 'alice-rule', 'always')
      rule('user.bob', 'bob-rule', 'always')
      expect(boot(eml, 'assistant').engrams).toBe(2)
      const r = boot(eml, 'assistant', { user: 'bob' })
      expect(r.markdown).toContain('bob-rule body')
      expect(r.markdown).not.toContain('alice-rule')
    })

    it('renders no other engram type', () => {
      writes(eml).store(validNote({ scope: 'global', content: 'note-content' }))
      writes(eml).store(validStatus({ scope: 'global', content: 'status-content', properties: { state: 'running' } }))
      writes(eml).store(validDecision({ scope: 'global', content: 'decision-content' }))
      writes(eml).store(validTask({ scope: 'global', content: 'task-content', status: 'active' }))
      writes(eml).store(validLog({ scope: 'global', content: 'log-content' }))
      const md = boot(eml, 'assistant').markdown
      for (const t of ['note', 'status', 'decision', 'task', 'log']) expect(md).not.toContain(`${t}-content`)
    })
  })

  describe('identity: the core profiles', () => {
    it('boots the profile marked core in agent.<self> and user.<self>', () => {
      profile('agent.assistant', 'assistant', 'I am Assistant')
      profile('user.alice', 'alice-identity', 'Alice is the user')
      const md = boot(eml, 'assistant').markdown
      expect(md).toMatch(/## Identity\n- \*\*\[agent\.assistant \| assistant\]\*\* I am Assistant\n- \*\*\[user\.alice \| alice-identity\]\*\* Alice is the user$/)
    })

    it('leaves out every other profile (facets, a title without core, other agents)', () => {
      profile('agent.assistant', 'assistant-tools', 'tool facet', false)
      profile('agent.assistant', 'assistant', 'titled like the old convention', false)
      profile('user.alice', 'alice-identity', 'old identity title', false)
      profile('agent.atlas', 'atlas', 'I am Atlas')
      const r = boot(eml, 'assistant')
      expect(r.engrams).toBe(0)
      expect(r.markdown).not.toContain('## Identity')
    })

    it('boots one core per scope: a new core profile supersedes the old one', () => {
      const first = profile('agent.assistant', 'assistant', 'I was Assistant')
      profile('agent.assistant', 'assistant-identity', 'I am Assistant now')
      expect(eml.engrams.get(first.id)!.status).toBe('superseded')
      const md = boot(eml, 'assistant').markdown
      expect(md).toContain('I am Assistant now')
      expect(md).not.toContain('I was Assistant')
    })
  })

  describe('rules: always in full, situational as an index', () => {
    it('renders always-rules whole and situational rules as title + trigger + id', () => {
      rule('agent.assistant', 'plan-first', 'always', 'Propose before you change state.')
      const s = rule('agent.assistant', 'port-means-port', 'situational', 'Port what the plan says.', 'a plan says to port code')
      const md = boot(eml, 'assistant').markdown
      expect(md).toContain('## Rules (always)\n- **[agent.assistant | plan-first]** Propose before you change state.')
      expect(md).toContain(`## Rules (situational — eml_get <id> when the trigger applies)\n- **[agent.assistant | port-means-port]** when: a plan says to port code · ${s.id}`)
      expect(md).not.toContain('Port what the plan says.')
    })

    it('orders agent.<self> before user.<self> before global, by title within a scope', () => {
      rule('global', 'a-global', 'always')
      rule('user.alice', 'b-user', 'always')
      rule('agent.assistant', 'd-agent', 'always')
      rule('agent.assistant', 'c-agent', 'always')
      const md = boot(eml, 'assistant').markdown
      const at = (s: string) => md.indexOf(s)
      expect(at('c-agent body')).toBeLessThan(at('d-agent body'))
      expect(at('d-agent body')).toBeLessThan(at('b-user body'))
      expect(at('b-user body')).toBeLessThan(at('a-global body'))
    })
  })

  describe('legacy entries (before the short format)', () => {
    it('lists an over-long rule, a situational rule without trigger and an over-long core profile by title only, and counts them', () => {
      const longRule = rule('global', 'long-rule', 'always')
      makeLegacy(eml, longRule.id, 'L'.repeat(450))
      const noTrigger = rule('agent.assistant', 'no-trigger', 'situational')
      makeLegacy(eml, noTrigger.id, 'short', { applies: 'situational', why: 'w', agreed: 'yes' })
      const longProfile = profile('agent.assistant', 'assistant')
      makeLegacy(eml, longProfile.id, 'P'.repeat(700))
      rule('global', 'fine', 'always')

      const r = boot(eml, 'assistant')
      expect(r.legacy).toBe(3)
      expect(r.markdown).toContain(`- [global | long-rule] · ${longRule.id}`)
      expect(r.markdown).toContain(`- [agent.assistant | no-trigger] · ${noTrigger.id}`)
      expect(r.markdown).toContain(`- [agent.assistant | assistant] · ${longProfile.id}`)
      expect(r.markdown).not.toContain('L'.repeat(201))
      expect(r.markdown).not.toContain('P'.repeat(401))
      expect(r.markdown).toContain('fine body')
      expect(r.markdown).toMatch(/\n---\n3 entries are in the old long format and listed by title only — eml_get <id> for the full text \(always-rules among them stay binding\)\.$/)
    })
  })

  describe('layout', () => {
    it('orders identity → always → situational → system rules → footer', () => {
      profile('agent.assistant', 'assistant')
      rule('agent.assistant', 'always-one', 'always')
      rule('agent.assistant', 'sit-one', 'situational')
      const legacy = rule('global', 'legacy-one', 'always')
      makeLegacy(eml, legacy.id, 'x'.repeat(300))
      const rules: SystemRule[] = [{ category: 'behavior', text: 'be helpful' }]
      const md = boot(eml, 'assistant', { systemRules: rules, version: '0.17.18' }).markdown
      const order = [
        '# EML Boot — assistant',
        '## Identity',
        '## Rules (always)',
        '## Rules (situational',
        '## EML System Rules (managed by engramprotocol v0.17.18)',
        '\n---\n',
      ].map(s => md.indexOf(s))
      expect(order.every(i => i >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    })

    it('omits empty sections', () => {
      const md = boot(eml, 'assistant', { systemRules: [] }).markdown
      for (const h of ['## EML System Rules', '## Identity', '## Rules', '---']) expect(md).not.toContain(h)
    })

    it('renders the system rules with category and the version tag', () => {
      const rules: SystemRule[] = [
        { category: 'behavior', text: 'be helpful' },
        { category: 'sot-hierarchy', text: 'brain is canonical' },
      ]
      const md = boot(eml, 'assistant', { systemRules: rules }).markdown
      expect(md).toContain('## EML System Rules (managed by engramprotocol)')
      expect(md).toContain('- [behavior] be helpful')
      expect(md).toContain('- [sot-hierarchy] brain is canonical')
    })

    it('has no footer when every entry is shown in full', () => {
      profile('agent.assistant', 'assistant')
      rule('global', 'fine', 'always')
      const md = boot(eml, 'assistant', { systemRules: [{ category: 'behavior', text: 'be helpful' }] }).markdown
      expect(md).not.toContain('---')
      expect(md).not.toContain('eml_recall')
      expect(md.endsWith('- [behavior] be helpful')).toBe(true)
    })

    it('does not render properties', () => {
      writes(eml).store({
        type: 'rule', scope: 'global', title: 'r', content: 'body',
        properties: { applies: 'always', why: 'because-text', agreed: 'agreed-text', detail: 'detail-text', review_due_at: '2026-10-14' },
      })
      const md = boot(eml, 'assistant').markdown
      expect(md).not.toContain('because-text')
      expect(md).not.toContain('detail-text')
      expect(md).not.toContain('agreed-text')
      expect(md).not.toContain('review_due_at')
    })
  })

  describe('opts.version', () => {
    it('is returned when provided, absent otherwise', () => {
      expect(boot(eml, 'assistant', { version: '0.10.1' }).version).toBe('0.10.1')
      expect(boot(eml, 'assistant').version).toBeUndefined()
    })
  })

  describe('counters (not rendered)', () => {
    it('counts open tasks and recent logs without rendering them', () => {
      writes(eml).store(validTask({ scope: 'global', content: 'planned-task' }))
      writes(eml).store(validTask({ scope: 'global', content: 'active-task', status: 'active' }))
      closedTask(eml, { scope: 'global', content: 'resolved-task' })
      writes(eml).store(validLog({ scope: 'global', content: 'session-summary-1' }))
      const result = boot(eml, 'assistant')
      expect(result.open_tasks).toBe(2)
      expect(result.recent_logs).toBe(1)
      expect(result.markdown).not.toContain('planned-task')
      expect(result.markdown).not.toContain('session-summary-1')
    })

    it('counts stale status', () => {
      writes(eml).store(validStatus({ scope: 'global', content: 'long status body', properties: { state: 'running' } }))
      expect(boot(eml, 'assistant', { reviewDays: -1 }).stale_status).toBe(1)
      expect(boot(eml, 'assistant', { reviewDays: 1000 }).stale_status).toBe(0)
    })

    it('counts overdue reviews of decisions/rules/profiles only, without a footer', () => {
      writes(eml).store(validDecision({ scope: 'global', title: 'old-decision', properties: { review_due_at: '2020-01-01T00:00:00Z' } }))
      // A task has no review_due_at (v0.19: no such field) — plant a legacy one raw.
      const task = writes(eml).store(validTask({ scope: 'global', content: 'task-with-due' }))
      makeLegacy(eml, task.id, 'task-with-due', { review_due_at: '2020-01-01T00:00:00Z' })
      const r = boot(eml, 'assistant')
      expect(r.overdue_review).toBe(1)
      expect(r.markdown).not.toContain('---')
    })
  })
})
