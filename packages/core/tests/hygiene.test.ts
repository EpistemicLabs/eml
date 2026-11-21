import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, hygieneCheck, HYGIENE_CHECKS, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { writes, legacyGlobalRule } from './fixtures'

// The brain-hygiene check (hygiene.ts).
describe('hygieneCheck()', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'assistant' })
    writes(eml).agents.store({ id: 'assistant', name: 'Assistant' })
    writes(eml).projects.create({ id: 'demo', name: 'Demo' })
  })
  afterEach(() => { eml.close() })

  // A legacy entry as it sits in an existing brain (written before the format).
  const plant = (id: string, content: string | null, properties?: Record<string, unknown>) => {
    const db = (eml as any).db
    if (content !== null) db.prepare('UPDATE engrams SET content = ? WHERE id = ?').run(content, id)
    if (properties) db.prepare('UPDATE engrams SET properties = ? WHERE id = ?').run(JSON.stringify(properties), id)
  }
  const check = (id: string, now?: Date) => hygieneCheck(eml, { now }).checks.find(c => c.id === id)!
  // v0.21: no rule is written in global any more; one from before sits there as a legacy entry.
  const rule = (scope: string, title: string, properties: Record<string, unknown> = { applies: 'always', why: 'w', agreed: 'yes' }) =>
    scope === 'global' ? legacyGlobalRule(eml, { title, content: 'do Y', properties }) : writes(eml).store({ type: 'rule', scope, title, content: 'do Y', properties })

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

  // v0.21: agent.<id> and user.<id> live in the agent brain; a re-scope or supersedes from a space
  // into them is refused (mcp-server routed-client), so no check's how may send an agent there (#179).
  it('no how re-scopes into agent.<id> or user.<id>', () => {
    for (const c of HYGIENE_CHECKS) {
      expect(c.how, c.id).not.toMatch(/eml_update\(scope\) to (agent|user)\./)
      expect(c.how, c.id).not.toMatch(/Re-scope the (rule|learning|profile) with eml_update\(scope\)/)
    }
  })

  describe('rule-profile-format', () => {
    it('finds legacy rules and profiles in every scope, with the format problem as reason', () => {
      const long = rule('project.demo', 'long-one')
      plant(long.id, 'x'.repeat(250))
      const noTrigger = rule('global', 'no-trigger')
      plant(noTrigger.id, null, { applies: 'situational' })
      const profile = writes(eml).store({ type: 'profile', scope: 'agent.assistant', title: 'assistant', content: 'short', properties: { core: true } })
      plant(profile.id, 'p'.repeat(500))
      rule('global', 'fine')

      const c = check('rule-profile-format')
      expect(c.kind).toBe('migration')
      const byId = Object.fromEntries(c.findings.map(f => [f.id, f]))
      expect(Object.keys(byId).sort()).toEqual([long.id, noTrigger.id, profile.id].sort())
      expect(byId[long.id]).toMatchObject({ type: 'rule', scope: 'project.demo', title: 'long-one' })
      expect(byId[long.id].reason).toMatch(/at most 200 characters \(got 250\)/)
      expect(byId[noTrigger.id].reason).toMatch(/needs trigger/)
      const both = rule('global', 'both')
      plant(both.id, 'x'.repeat(250), { applies: 'situational' })
      expect(check('rule-profile-format').findings.find(f => f.id === both.id)!.reason).toMatch(/in detail\. A situational rule needs/)
      expect(byId[profile.id].reason).toMatch(/at most 400 characters \(got 500\)/)
    })

    it('ignores entries that are no longer active', () => {
      const old = rule('global', 'old')
      plant(old.id, 'x'.repeat(250))
      writes(eml).update(old.id, { status: 'invalidated' })
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

    it('v0.20: a due date written without a zone is stored as UTC (ISO-8601 ms) and compared as such', () => {
      const now = new Date('2026-10-19T12:00:00.000Z')
      const soon = rule('global', 'due-in-30-min')
      writes(eml).update(soon.id, { properties: { review_due_at: '2026-10-19 12:30:00' } })
      const isoSoon = rule('global', 'iso-due-in-30-min')
      writes(eml).update(isoSoon.id, { properties: { review_due_at: '2026-10-19T12:30' } })
      const past = rule('global', 'due-30-min-ago')
      writes(eml).update(past.id, { properties: { review_due_at: '2026-10-19 11:30:00' } })
      const day = rule('global', 'due-today')
      writes(eml).update(day.id, { properties: { review_due_at: '2026-10-19' } })
      expect(eml.engrams.get(soon.id)!.properties!.review_due_at).toBe('2026-10-19T12:30:00.000Z')
      expect(eml.engrams.get(isoSoon.id)!.properties!.review_due_at).toBe('2026-10-19T12:30:00.000Z')
      expect(eml.engrams.get(day.id)!.properties!.review_due_at).toBe('2026-10-19T00:00:00.000Z')
      expect(check('review-due', now).findings.map(f => f.title).sort()).toEqual(['due-30-min-ago', 'due-today'])
    })

    it('leaves tasks out, even when they are review due', () => {
      const task = writes(eml).store({ type: 'task', scope: 'project.demo', title: 'idle', content: 'x', status: 'active' })
      ;(eml as any).db.prepare(`UPDATE engrams SET updated_at = datetime('now', '-60 days') WHERE id = ?`).run(task.id)
      ;(eml as any).db.prepare(`UPDATE entries SET at = datetime('now', '-60 days') WHERE engram_id = ?`).run(task.id)
      expect(eml.engrams.get(task.id)!.review_due).toBe(true)
      expect(check('review-due').findings).toEqual([])
    })

    it('ignores entries that are no longer active', () => {
      const old = rule('global', 'old-due')
      plant(old.id, null, { applies: 'always', review_due_at: '2020-01-01T00:00:00.000Z' })
      writes(eml).update(old.id, { status: 'invalidated' })
      expect(check('review-due').findings).toEqual([])
    })
  })

  describe('schema 19', () => {
    const ctx = () => eml.env({ handle: 'assistant' })
    const ids = (id: string) => check(id).findings.map(f => f.id).sort()

    it('all schema 19 checks are migration checks with since_schema 19, before the review check', () => {
      const r = hygieneCheck(eml)
      const nineteen = r.checks.filter(c => c.since_schema === 19).map(c => c.id)
      expect(nineteen).toEqual([
        'reference-without-source', 'profile-scope',
        'rule-without-why', 'rule-without-agreement', 'task-link-without-binding', 'decision-without-rationale',
      ])
      // the recurring checks come last: review-due, the learning check, then the conflict sweep
      expect(r.checks.slice(-3).map(c => c.id)).toEqual(['review-due', 'learning-unclear', 'conflict-scan'])
    })

    it('reference-without-source: active references without source', () => {
      const ok = writes(eml).store({ type: 'reference', scope: 'global', title: 'ok', content: 'x', properties: { source: 'https://x' } })
      const bare = writes(eml).store({ type: 'reference', scope: 'global', title: 'bare', content: 'y', properties: { source: 'tmp' } })
      plant(bare.id, null, {})
      expect(ids('reference-without-source')).toEqual([bare.id])
      expect(ok.id).toBeDefined()
    })

    it('profile-scope: an active profile outside agent / user / entity', () => {
      const p = writes(eml).store({ type: 'profile', scope: 'agent.assistant', title: 'vps-access', content: 'how to reach the VPS' })
      ;(eml as any).db.prepare(`UPDATE engrams SET scope = 'global' WHERE id = ?`).run(p.id)
      writes(eml).store({ type: 'profile', scope: 'agent.assistant', title: 'fine', content: 'a facet' })
      expect(ids('profile-scope')).toEqual([p.id])
    })

    it('rule-without-why and rule-without-agreement: older rules', () => {
      const r = rule('global', 'old-rule')
      plant(r.id, null, { applies: 'always' })
      const half = rule('global', 'half')
      plant(half.id, null, { applies: 'always', why: 'because' })
      rule('global', 'new-rule')
      expect(ids('rule-without-why')).toEqual([r.id])
      expect(ids('rule-without-agreement')).toEqual([half.id, r.id].sort())
    })

    it('a single-incident rule is turned into a learning on the user\'s word', () => {
      const r = rule('agent.assistant', 'ask-first')
      plant(r.id, null, { applies: 'always', why: 'once' })
      const l = writes(eml).learn({ scope: 'agent.assistant', title: 'ask-first-learning', content: 'Ask first.', source: 'self', happened: 'once' }, ctx())
      if (!l.written) throw new Error('not written')
      writes(eml).update(l.engram.id, { supersedes: [r.id] }, ctx())
      expect(eml.engrams.get(r.id)!.status).toBe('superseded')
      expect(ids('rule-without-agreement')).toEqual([])
    })

    it('task-link-without-binding: task-linked decisions and notes without binding, with the task status', () => {
      const task = writes(eml).store({ type: 'task', scope: 'project.demo', title: 't', content: 'do' })
      const d = writes(eml).store({
        type: 'decision', scope: 'project.demo', title: 'd', content: 'pick', task_id: task.id,
        properties: { rationale: 'r', alternatives: ['x'], binding: 'standing' },
      })
      plant(d.id, null, { rationale: 'r', alternatives: ['x'] })
      writes(eml).store({
        type: 'note', scope: 'project.demo', title: 'n', content: 'plan', task_id: task.id, properties: { binding: 'task' },
      })
      const c = check('task-link-without-binding')
      expect(c.findings.map(f => f.id)).toEqual([d.id])
      expect(c.findings[0].reason).toBe('taken in a task (planned), no binding.')
    })
  })

  describe('conflict-scan', () => {
    const content = 'quantumflux pipeline sweep threshold coverage'

    it('surfaces an unresolved pair once, owned by the newer engram, naming the other side', () => {
      const a = writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-one', content })
      const b = writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-two', content: 'quantumflux pipeline sweep threshold gate' })
      const f = check('conflict-scan').findings
      expect(f).toHaveLength(1)
      expect(f[0].id).toBe(b.id) // the newer engram carries the pair
      expect(f[0].reason).toContain('possible conflict with ' + a.id.slice(0, 8))
      expect(f[0].reason).toContain('word overlap')
    })

    it('excludes a pair with a verdict edge (a drawn related_to)', () => {
      const a = writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-edge-a', content })
      const b = writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-edge-b', content: 'quantumflux pipeline sweep threshold gate' })
      writes(eml).relate({ source_id: a.id, target_id: b.id, relation: 'related_to', explanation: 'judged distinct' })
      expect(check('conflict-scan').findings).toEqual([])
    })

    it('excludes the same-task thread (planned task, task-bound siblings with overlapping vocabulary)', () => {
      const task = writes(eml).store({ type: 'task', scope: 'project.demo', title: 'qf-task', content: 'the quantumflux work' })
      writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-task-a', content, task_id: task.id, properties: { binding: 'task' } })
      writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-task-b', content: 'quantumflux pipeline sweep threshold gate', task_id: task.id, properties: { binding: 'task' } })
      expect(check('conflict-scan').findings).toEqual([])
    })

    it('excludes the same-task thread across scopes (the bound task sits in another scope)', () => {
      const task = writes(eml).store({ type: 'task', scope: 'global', title: 'qf-xscope-task', content: 'the quantumflux work' })
      writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-xscope-a', content, task_id: task.id, properties: { binding: 'task' } })
      writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-xscope-b', content: 'quantumflux pipeline sweep threshold gate', task_id: task.id, properties: { binding: 'task' } })
      expect(check('conflict-scan').findings).toEqual([])
    })

    it('never takes a log or learning as a sweep subject (the write-time scan leaves them out)', () => {
      writes(eml).store({ type: 'log', scope: 'project.demo', title: 'qf-log', content, properties: { what: 'w', landed: 'l', next: 'n' } })
      writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-note', content: 'quantumflux pipeline sweep threshold gate' })
      expect(check('conflict-scan').findings).toEqual([])
    })

    it('flags a same-title pair without an edge, marked lineage (the concurrent-writer case)', () => {
      writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-dup', content })
      writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-dup', content: 'quantumflux pipeline sweep threshold repeat' })
      const f = check('conflict-scan').findings
      expect(f).toHaveLength(1)
      expect(f[0].reason).toContain('same title')
    })

    it('takes a chained same-title series as one thread (each member linked to the previous one)', () => {
      const round = (c: string) => writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-series', content: c })
      const first = round(content)
      const second = round('quantumflux pipeline sweep threshold gate')
      const third = round('quantumflux pipeline sweep threshold round three')
      writes(eml).relate({ source_id: second.id, target_id: first.id, relation: 'refines' })
      // first and third have no edge of their own yet: third is still unlinked
      expect(check('conflict-scan').findings.map(f => f.id)).toEqual([third.id, third.id])
      writes(eml).relate({ source_id: third.id, target_id: second.id, relation: 'refines' })
      expect(check('conflict-scan').findings).toEqual([])
    })

    it('a task both are bound to is no bridge: a same-title pair inside one task stays flagged', () => {
      const task = writes(eml).store({ type: 'task', scope: 'project.demo', title: 'qf-same', content: 'the quantumflux work' })
      writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-same', content, task_id: task.id, properties: { binding: 'task' } })
      writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-same', content: 'quantumflux pipeline sweep threshold gate', task_id: task.id, properties: { binding: 'task' } })
      const f = check('conflict-scan').findings
      expect(f).toHaveLength(1)
      expect(f[0].reason).toContain('same title')
    })

    it('caps the findings at 20 per run (the next sweep surfaces the rest)', () => {
      for (let i = 0; i < 24; i++) writes(eml).store({ type: 'note', scope: 'project.demo', title: `qf-cap-${i}`, content })
      expect(check('conflict-scan').findings).toHaveLength(20)
    })

    it('leaves pairs with a retired side out (a superseded engram is not a candidate)', () => {
      const a = writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-retired', content })
      writes(eml).store({ type: 'note', scope: 'project.demo', title: 'qf-successor', content: 'quantumflux pipeline sweep threshold gate', supersedes: [a.id] })
      expect(check('conflict-scan').findings).toEqual([])
    })
  })
})
