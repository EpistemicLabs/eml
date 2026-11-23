import { describe, it, expect } from 'vitest'
import { planSplit, type SplitSource } from '../src/domain/split.js'

const withTask: SplitSource = { sessionId: 's1', sessionTitle: 'Session review', taskId: 't-root', taskTitle: 'session-review-ui', taskSystem: true }
const noTask: SplitSource = { sessionId: 's1', sessionTitle: 'Session review', taskId: null, taskTitle: null, taskSystem: false }
const request = { title: 'Media viewer', brief: 'Goal: open files in the cockpit.', scope: 'project.ui' }

describe('splitting off a topic', () => {
  it('spun off: its own task, linked to the task it came from, journaled on both', () => {
    const plan = planSplit(withTask, { ...request, relation: 'spun', when: 'now' })
    expect(plan).toEqual({
      ok: true,
      plan: {
        task: { title: 'media-viewer', display_title: 'Media viewer', content: 'Media viewer\n\nGoal: open files in the cockpit.', scope: 'project.ui', status: 'active' },
        originLink: true,
        journal: { created: 'Spun off from session-review-ui (session Session review).', source: 'Media viewer was spun off here as its own task.' },
        spawn: true,
      },
    })
  })

  it('sub-task: under the session\'s task, which cannot close before it', () => {
    const plan = planSplit(withTask, { ...request, relation: 'sub', when: 'park' })
    expect(plan.ok && plan.plan).toMatchObject({ task: { parent_id: 't-root', status: 'planned' }, originLink: false, spawn: false })
    expect(plan.ok && plan.plan.journal.source).toBe('Media viewer was split off here as a sub-task; this task can\'t close before it.')
  })

  it('unrelated: its own task with no link; the journal says where it came up', () => {
    const plan = planSplit(withTask, { ...request, relation: 'unrelated', when: 'now' })
    expect(plan.ok && plan.plan).toMatchObject({ originLink: false, spawn: true, journal: { created: 'Came up in session-review-ui (session Session review); not part of that task.' } })
    expect(plan.ok && plan.plan.task).not.toHaveProperty('parent_id')
  })

  it('without the task system, starting now writes nothing to the brain', () => {
    expect(planSplit(noTask, { ...request, relation: 'spun', when: 'now' })).toEqual({
      ok: true, plan: { task: null, originLink: false, journal: {}, spawn: true },
    })
  })

  it('without the task system, parking makes one ordinary task that says where it came up', () => {
    const plan = planSplit(noTask, { ...request, relation: 'unrelated', when: 'park' })
    expect(plan.ok && plan.plan).toEqual({
      task: { title: 'media-viewer', display_title: 'Media viewer', content: 'Media viewer\n\nGoal: open files in the cockpit.\n\nCame up in session Session review.', scope: 'project.ui', status: 'planned' },
      originLink: false, journal: {}, spawn: false,
    })
  })

  it('refuses a sub-task where there is no task to hang it under, and an empty title or brief', () => {
    expect(planSplit(noTask, { ...request, relation: 'sub', when: 'now' })).toEqual({ ok: false, refusal: 'sub_needs_task' })
    expect(planSplit(withTask, { ...request, title: ' ', relation: 'spun', when: 'now' })).toEqual({ ok: false, refusal: 'invalid' })
    expect(planSplit(withTask, { ...request, brief: '', relation: 'spun', when: 'now' })).toEqual({ ok: false, refusal: 'invalid' })
  })

  it('refuses a title that leaves no anchor', () => {
    expect(planSplit(withTask, { ...request, title: '✨', relation: 'spun', when: 'now' })).toEqual({ ok: false, refusal: 'invalid' })
  })

  it('onto an existing task: nothing new is made; starting now opens a session on it', () => {
    const plan = planSplit(withTask, { ...request, relation: 'spun', when: 'now', existing: { id: 't-fix', title: 'fix-ended-mail-job' } })
    expect(plan).toEqual({ ok: true, plan: {
      task: null, originLink: false, spawn: true,
      journal: { existing: 'Picked up again from session-review-ui (session Session review).', source: 'Media viewer continues in its task fix-ended-mail-job.' },
    } })
  })

  it('onto an existing task, parked: the brief goes into its journal', () => {
    const plan = planSplit(noTask, { ...request, relation: 'unrelated', when: 'park', existing: { id: 't-fix', title: 'fix-ended-mail-job' } })
    expect(plan.ok && plan.plan).toEqual({ task: null, originLink: false, spawn: false, journal: { existing: 'Came up again in session Session review:\n\nGoal: open files in the cockpit.' } })
  })
})
