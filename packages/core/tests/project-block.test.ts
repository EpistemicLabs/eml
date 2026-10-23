import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, projectBlock, projectScopeChain, inheritedRules, renderBrainStateMarkdown } from '../src'
import { validDecision, validTask, validRule, validLog } from './fixtures'

// Legacy rules (written before the short format) cannot be stored through the
// store any more; tests plant them with a raw UPDATE, as boot.test.ts does.
function makeLegacy(eml: EML, id: string, content: string): void {
  ;(eml as any).db.prepare('UPDATE engrams SET content = ? WHERE id = ?').run(content, id)
}

describe('projectBlock()', () => {
  let eml: EML

  const rule = (scope: string, title: string, applies: 'always' | 'situational', content = `${title} body`) =>
    eml.engrams.store(validRule({
      scope, title, content,
      properties: { applies, ...(applies === 'situational' && { trigger: `${title} situation` }) },
    }))
  const task = (title: string, priority = 'normal', content = `${title} work`) =>
    eml.engrams.store(validTask({ scope: 'project.app', title, content, properties: { priority } }))

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'assistant' })
    eml.projects.create({ id: 'base', name: 'Base' })
    eml.projects.create({ id: 'app', name: 'App', parent_project: 'base' })
  })
  afterEach(() => eml.close())

  it('returns null for a project the brain does not know', () => {
    expect(projectBlock(eml, 'nope')).toBeNull()
  })

  it('renders an empty project as header alone', () => {
    expect(projectBlock(eml, 'app')!.markdown).toBe(
      '# Project — project.app (App)\nThe rules below are binding while you work in this project.')
  })

  it('renders status, tasks, latest session, situational and always rules — in that order, no decisions', () => {
    eml.engrams.store({ type: 'status', scope: 'project.app', content: 'v1 shipped', properties: { state: 'live', next_step: 'v2' } })
    task('build-thing', 'high')
    eml.engrams.store(validLog({ scope: 'project.app', title: 'session-1', content: 'did things' }))
    rule('project.app', 'when-deploying', 'situational')
    rule('project.app', 'always-test', 'always')
    eml.engrams.store(validDecision({ scope: 'project.app', title: 'chose-x' }))

    const md = projectBlock(eml, 'app')!.markdown
    const order = ['## Status', '- [live] v1 shipped · next: v2', '## Open tasks (1)', '- [high·planned] build-thing — build-thing work',
      '## Latest session', '- session-1 ·', '## Rules (situational', '- **when-deploying** when: when-deploying situation ·',
      '## Rules (always)', '- **always-test** always-test body']
    let at = -1
    for (const part of order) {
      const next = md.indexOf(part)
      expect(next, part).toBeGreaterThan(at)
      at = next
    }
    expect(md).not.toContain('chose-x')
    expect(md).not.toContain('did things')
  })

  it('carries the rules of parent projects, marked inherited', () => {
    rule('project.base', 'base-always', 'always')
    rule('project.base', 'base-when', 'situational')
    rule('project.app', 'own-always', 'always')
    const md = projectBlock(eml, 'app')!.markdown
    expect(md).toContain('- **own-always** own-always body')
    expect(md).toContain('- **base-always** (inherited from project.base) base-always body')
    expect(md).toContain('- **base-when** (inherited from project.base) when: base-when situation')
    expect(md.indexOf('own-always')).toBeLessThan(md.indexOf('base-always'))
    // The parent's own block has no inherited marker.
    expect(projectBlock(eml, 'base')!.markdown).not.toContain('inherited')
  })

  it('lists the first 10 tasks by priority, the rest as a count', () => {
    for (let i = 0; i < 12; i++) task(`t${String(i).padStart(2, '0')}`, i === 11 ? 'urgent' : 'normal', 'x'.repeat(150))
    const r = projectBlock(eml, 'app')!
    expect(r.open_tasks).toBe(12)
    expect(r.markdown).toContain('## Open tasks (12)')
    expect(r.markdown.indexOf('t11')).toBeLessThan(r.markdown.indexOf('t00'))
    expect(r.markdown).toContain(`— ${'x'.repeat(100)}…`)
    expect(r.markdown).toContain('- 2 more open tasks — eml_list type=task scope=project.app')
  })

  it('shows legacy rules by title only and counts them in the hints', () => {
    const r = rule('project.app', 'old-rule', 'always')
    makeLegacy(eml, r.id, 'x'.repeat(400))
    const block = projectBlock(eml, 'app')!
    expect(block.legacy).toBe(1)
    expect(block.markdown).toContain(`- old-rule · ${r.id}`)
    expect(block.markdown).not.toContain('x'.repeat(400))
    expect(block.markdown).toContain('1 rules are in the old long format')
  })

  it('counts the engrams due for review', () => {
    eml.engrams.store(validDecision({ scope: 'project.app', title: 'stale', properties: { review_due_at: '2020-01-01T00:00:00.000Z' } }))
    const r = projectBlock(eml, 'app')!
    expect(r.pending_reviews).toBe(1)
    expect(r.markdown).toContain('- 1 engrams in this project are due for review.')
  })

  describe('size budget', () => {
    beforeEach(() => {
      eml.engrams.store({ type: 'status', scope: 'project.app', content: 'state of things', properties: { state: 'ok' } })
      for (let i = 0; i < 10; i++) task(`task-${i}`, 'normal', 'y'.repeat(200))
      eml.engrams.store(validLog({ scope: 'project.app', title: 'session-log', content: 'log' }))
      for (let i = 0; i < 3; i++) rule('project.app', `sit-${i}`, 'situational')
      for (let i = 0; i < 3; i++) rule('project.app', `alw-${i}`, 'always', `${'z'.repeat(150 + i)}`)
    })

    it('reports an untouched block within budget', () => {
      const r = projectBlock(eml, 'app', { budget: 100_000 })!
      expect(r.budget).toMatchObject({ fits: true, tasks_title_only: 0, tasks_left_out: 0, log_left_out: false, situational_title_only: 0, always_title_only: 0, rules_left_out: 0 })
      expect(r.markdown).not.toContain('## Hints')
    })

    it('gives way in order: task previews, tasks, log, triggers, always-rules — never mid-text', () => {
      const full = projectBlock(eml, 'app')!.markdown.length
      let last = { tasks_title_only: 0, tasks_left_out: 0, log: 0, situational: 0, always: 0 }
      let sawAlways = false
      let sawLeftOut = false
      for (let limit = full; limit > 300; limit -= 40) {
        const r = projectBlock(eml, 'app', { budget: limit })!
        const b = r.budget!
        // Header, status and hints are the floor; below it the block reports fits=false.
        if (!b.fits) break
        expect(r.markdown.length).toBeLessThanOrEqual(limit)
        // Nothing is cut: every rule body is whole or absent.
        for (let i = 0; i < 3; i++) {
          const body = 'z'.repeat(150 + i)
          if (r.markdown.includes(`alw-${i}** `)) expect(r.markdown).toContain(body)
        }
        expect(r.markdown).not.toMatch(/y{101}/)
        const now = { tasks_title_only: b.tasks_title_only, tasks_left_out: b.tasks_left_out, log: b.log_left_out ? 1 : 0, situational: b.situational_title_only, always: b.always_title_only }
        // A later stage only starts once the earlier ones are exhausted.
        if (now.tasks_left_out > 0) expect(now.tasks_title_only + now.tasks_left_out).toBe(10)
        if (now.log > 0) expect(now.tasks_left_out).toBe(10)
        if (now.situational > 0) expect(now.log).toBe(1)
        if (now.always > 0) expect(now.situational + b.rules_left_out).toBeGreaterThanOrEqual(3)
        expect(now.tasks_left_out).toBeGreaterThanOrEqual(last.tasks_left_out)
        sawAlways ||= now.always > 0
        sawLeftOut ||= b.rules_left_out > 0
        last = now
      }
      expect(sawAlways && sawLeftOut).toBe(true)
    })

    it('says in the hints that entries gave way', () => {
      const r = projectBlock(eml, 'app', { budget: 2000 })!
      expect(r.markdown).toMatch(/- \d+ entries shortened or left out to fit the block's size budget — eml_show project\.app/)
    })
  })
})

describe('project parents', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'assistant' })
    eml.projects.create({ id: 'root', name: 'Root' })
    eml.projects.create({ id: 'mid', name: 'Mid', parent_project: 'root' })
    eml.projects.create({ id: 'leaf', name: 'Leaf', parent_project: 'mid' })
  })
  afterEach(() => eml.close())

  it('walks the chain nearest first', () => {
    expect(projectScopeChain(eml, 'leaf')).toEqual(['project.leaf', 'project.mid', 'project.root'])
    expect(projectScopeChain(eml, 'nope')).toEqual([])
  })

  it('gives eml_show the parents\' rules, marked inherited', () => {
    eml.engrams.store(validRule({ scope: 'project.root', title: 'root-rule', content: 'root body' }))
    eml.engrams.store(validRule({ scope: 'project.leaf', title: 'leaf-rule', content: 'leaf body' }))
    expect(inheritedRules(eml, 'project.leaf').map(r => r.title)).toEqual(['root-rule'])
    expect(inheritedRules(eml, 'global')).toEqual([])
    const state = eml.engrams.buildBrainState('project.leaf')
    state.rules = [...(state.rules ?? []), ...inheritedRules(eml, 'project.leaf')]
    const md = renderBrainStateMarkdown(state)
    expect(md).toContain('- **leaf-rule** — leaf body')
    expect(md).toContain('- **root-rule** (inherited from project.root) — root body')
  })
})
