import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, hygieneCheck } from '../src'
import {
  validDecision, validTask, validNote, writes,
} from './fixtures'

// v0.19.1 — the task lifecycle simplified (decisions subtasks-close-before-parent,
// review-per-type): a reopen offers back only what closed with the task, a
// task-bound decision is not reviewed, eml_learning takes no task_id.

describe('task lifecycle', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'juno' })
    writes(eml).agents.store({ id: 'juno', name: 'Juno' })
    writes(eml).users.create({ id: 'ada', name: 'Ada' })
  })
  afterEach(() => { eml.close() })

  const statusOf = (id: string) => eml.engrams.get(id)!.status
  const propsOf = (id: string) => (eml.engrams.get(id)!.properties ?? {}) as Record<string, unknown>
  const bound = (taskId: string, make: typeof validDecision | typeof validNote = validDecision) =>
    writes(eml).store(make({ task_id: taskId, properties: { binding: 'task' } }))
  const reopen = (taskId: string) =>
    (writes(eml).trackTask(taskId, { status: 'active', text: 'back on' })!.reopen_candidates ?? []).map(c => c.id)
  const close = (taskId: string, status: 'resolved' | 'invalidated' = 'resolved') =>
    writes(eml).trackTask(taskId, { status, outcome: 'done', text: 'done', keep: [] })

  describe('a reopen offers back what closed with the task', () => {
    it('not an item closed by hand before the task closed', () => {
      const task = writes(eml).store(validTask())
      const withTask = bound(task.id)
      const byHand = bound(task.id, validNote)
      writes(eml).update(byHand.id, { status: 'invalidated' })
      close(task.id)
      expect(statusOf(withTask.id)).toBe('resolved')
      expect(eml.engrams.entries(withTask.id, ['change']).pop()!.text).toBe(`closed with task ${task.id}`)
      expect(reopen(task.id)).toEqual([withTask.id])
    })

    it('not an item reactivated after a reopen and then closed by hand', () => {
      const task = writes(eml).store(validTask())
      const d = bound(task.id)
      close(task.id)
      expect(reopen(task.id)).toEqual([d.id])
      writes(eml).update(d.id, { status: 'active' })
      writes(eml).update(d.id, { status: 'invalidated' })
      expect(eml.engrams.entries(d.id, ['change']).map(e => e.text).slice(-2)).toEqual(['status resolved → active', 'status active → invalidated'])
      close(task.id, 'invalidated')
      expect(reopen(task.id)).toEqual([])
    })
  })

  describe('review', () => {
    const due = (days: number) => new Date(Date.now() + days * 86400_000).toISOString()

    it('a task-bound decision is not reviewed; a standing one is', () => {
      const task = writes(eml).store(validTask())
      const taskBound = bound(task.id)
      const standing = writes(eml).store(validDecision({ title: 'standing' }))
      const later = due(61)
      expect(eml.engrams.query({ review_due: true, now: later }).map(e => e.id)).toEqual([standing.id])
      expect(eml.engrams.query({ type: 'decision', now: later }).find(e => e.id === taskBound.id)!.review_due).toBe(false)
      const findings = hygieneCheck(eml, { now: new Date(later) }).checks.find(c => c.id === 'review-due')!.findings
      expect(findings.map(f => f.id)).toEqual([standing.id])
    })

    it('a decision kept as standing at the close starts its review clock then', () => {
      const task = writes(eml).store(validTask())
      const d = bound(task.id)
      const before = Date.now()
      writes(eml).trackTask(task.id, { status: 'resolved', outcome: 'done', text: 'done', keep: [d.id] })
      expect(propsOf(d.id).binding).toBe('standing')
      expect(Date.parse(propsOf(d.id).review_due_at as string)).toBeGreaterThanOrEqual(before + 60 * 86400_000)
    })
  })

  it('eml_learning takes no task_id', () => {
    const task = writes(eml).store(validTask())
    expect(() => writes(eml).learn({ scope: 'user.ada', title: 't', content: 'Do T.', source: 'observed', happened: 'h', task_id: task.id } as any))
      .toThrow(/task_id/)
  })
})
