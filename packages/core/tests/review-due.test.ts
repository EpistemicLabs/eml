import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, boot, hygieneCheck, projectBlock, TASK_INACTIVITY_DAYS } from '../src'
import {
  validDecision, validTask, validRule, validNote, writes,
} from './fixtures'

// v0.20 (decision drop-labels-axis): review_due is computed at read time in one
// place (review-due.ts) and every read path that lists, filters or renders review
// state carries the same answer. No sweep, no stored label.
describe('review_due on every read path', () => {
  let eml: EML
  let due: { decision: string, rule: string, task: string }
  let notDue: { fresh: string, bound: string, planned: string, closed: string, note: string }

  const rawDb = (): any => (eml as any).db
  const age = (id: string, days: number) => {
    rawDb().prepare(`UPDATE engrams SET updated_at = datetime('now', ?) WHERE id = ?`).run(`-${days} days`, id)
    rawDb().prepare(`UPDATE entries SET at = ? WHERE engram_id = ?`).run(new Date(Date.now() - days * 86400_000).toISOString(), id)
  }
  const pastReview = { review_due_at: '2020-01-01T00:00:00.000Z' }
  const scope = 'project.app'

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'assistant' })
    writes(eml).agents.store({ id: 'assistant', name: 'Assistant' })
    writes(eml).projects.create({ id: 'app', name: 'App' })
    const openTask = writes(eml).store(validTask({ scope, title: 'open-task', status: 'active' }))
    const idle = writes(eml).store(validTask({ scope, title: 'idle-task', status: 'active' }))
    age(idle.id, TASK_INACTIVITY_DAYS + 5)
    const planned = writes(eml).store(validTask({ scope, title: 'parked-task' }))
    age(planned.id, TASK_INACTIVITY_DAYS + 5)
    const closed = writes(eml).store(validTask({ scope, title: 'closed-task', status: 'active' }))
    writes(eml).trackTask(closed.id, { status: 'resolved', outcome: 'done', text: 'done' })
    age(closed.id, TASK_INACTIVITY_DAYS + 5)
    due = {
      decision: writes(eml).store(validDecision({ scope, title: 'stale-decision', properties: pastReview })).id,
      rule: writes(eml).store(validRule({ scope, title: 'stale-rule', properties: { applies: 'always', ...pastReview } })).id,
      task: idle.id,
    }
    notDue = {
      fresh: writes(eml).store(validDecision({ scope, title: 'fresh-decision' })).id,
      bound: writes(eml).store(validDecision({ scope, title: 'bound-decision', task_id: openTask.id, properties: { binding: 'task', ...pastReview } })).id,
      planned: planned.id,
      closed: closed.id,
      note: writes(eml).store(validNote({ scope, title: 'a-note' })).id,
    }
  })
  afterEach(() => eml.close())

  const dueIds = () => Object.values(due).sort()
  const check = (engrams: Array<{ id: string, review_due: boolean }>) => {
    const byId = new Map(engrams.map(e => [e.id, e.review_due]))
    for (const id of Object.values(due)) if (byId.has(id)) expect(byId.get(id), id).toBe(true)
    for (const id of Object.values(notDue)) if (byId.has(id)) expect(byId.get(id), id).toBe(false)
  }

  it('get', () => {
    for (const id of Object.values(due)) expect(eml.engrams.get(id)!.review_due).toBe(true)
    for (const id of Object.values(notDue)) expect(eml.engrams.get(id)!.review_due).toBe(false)
  })

  it('list: the field on every row, and the review_due filter both ways', () => {
    const all = eml.engrams.query({ scope, limit: 100 })
    expect(all.length).toBe(Object.keys(due).length + Object.keys(notDue).length + 1)
    check(all)
    expect(eml.engrams.query({ scope, review_due: true, limit: 100 }).map(e => e.id).sort()).toEqual(dueIds())
    const rest = eml.engrams.query({ scope, review_due: false, limit: 100 }).map(e => e.id)
    expect(rest).toHaveLength(all.length - dueIds().length)
    expect(rest.some(id => dueIds().includes(id))).toBe(false)
  })

  it('recall: search results carry it (bm25 path and plain search)', () => {
    const scored = eml.engrams.query({ search: 'stale', search_mode: 'or', order_by: 'score', limit: 20 })
    expect(scored.map(e => e.id)).toEqual(expect.arrayContaining([due.decision, due.rule]))
    check(scored)
    check(eml.engrams.query({ search: 'decision', limit: 20 }))
  })

  it('show: the scope\'s pending reviews and every engram in the brain state', () => {
    const state = eml.engrams.buildBrainState(scope)
    expect(state.pending_reviews!.map(e => e.id).sort()).toEqual(dueIds())
    check([...state.open_tasks, ...state.recent_decisions, ...(state.rules ?? []), ...state.pending_reviews!])
  })

  it('project brain state', () => {
    const state = eml.projects.getBrainState('app')!
    check([...state.open_tasks, ...state.recent_decisions])
    expect(state.open_tasks.find(e => e.id === due.task)!.review_due).toBe(true)
  })

  it('project block: the count', () => {
    expect(projectBlock(eml, 'app')!.pending_reviews).toBe(dueIds().length)
  })

  it('boot: overdue_review counts the dated types', () => {
    expect(boot(eml, 'assistant').overdue_review).toBe(2)
  })

  it('hygiene: the review-due check lists the dated types', () => {
    const findings = hygieneCheck(eml).checks.find(c => c.id === 'review-due')!.findings
    expect(findings.map(f => f.id).sort()).toEqual([due.decision, due.rule].sort())
  })

  it('ends with the write that answers it, with no sweep in between', () => {
    writes(eml).confirmReview(due.decision, 'still holds')
    writes(eml).update(due.rule, { status: 'invalidated' })
    writes(eml).trackTask(due.task, { text: 'picked up again' })
    expect(eml.engrams.query({ scope, review_due: true, limit: 100 })).toEqual([])
  })
})
