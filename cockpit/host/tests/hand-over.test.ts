import { describe, it, expect } from 'vitest'
import { planHandOver, planUndo, scheduledJobOptions, type HandOverTask } from '../src/domain/hand-over.js'

const NOW = '2026-11-24T10:00:00.000Z'
const ctx = { agents: ['atlas', 'motti'], now: NOW }
const task = (patch: Partial<HandOverTask> = {}): HandOverTask => ({ id: 't1', status: 'active', owner: 'lasse', ...patch })

describe('planning a hand-over', () => {
  it('delegate now: writes the delegation with its request, keeps the owner, journals it', () => {
    const r = planHandOver(task({ status: 'planned' }), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.patch).toEqual({ delegation: { agent: 'atlas', checkpoint: 'after', requested_at: NOW } })
    expect(r.plan.patch).not.toHaveProperty('assignee_ids')
    expect(r.plan.journal).toBe('Handed to atlas with checkpoint after; the owner stays.')
    expect(r.plan.job).toBeUndefined()
    expect(r.plan.session).toBeUndefined()
  })

  it('take over: on a task with its own session, together opens that session, needs no desk and journals it as taken over', () => {
    const r = planHandOver(task({ delegate: 'atlas', delegation: { agent: 'atlas', checkpoint: 'after' } }), { mode: 'together', delegate: 'atlas' }, { ...ctx, ownSession: 's1' })
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.patch).toEqual({ delegation: null })
    expect(r.plan.session).toEqual({ sessionId: 's1' })
    expect(r.plan.journal).toBe('Taken over by the owner in its session. atlas is no longer delegated, so it does not go on alone; a turn it is in finishes first.')
    const inDesk = planHandOver(task(), { mode: 'together', delegate: 'atlas', desk: 'Main' }, { ...ctx, ownSession: 's1' })
    if (!inDesk.ok) throw new Error(inDesk.refusal)
    expect(inDesk.plan.session).toEqual({ desk: 'Main', sessionId: 's1' })
    expect(planHandOver(task(), { mode: 'together', delegate: 'atlas' }, ctx)).toEqual({ ok: false, refusal: 'desk_required' })
  })

  it('delegate now on an active task leaves its status alone: the request starts it (status moves forward only)', () => {
    const r = planHandOver(task({ status: 'active' }), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.patch).not.toHaveProperty('status')
    expect(r.plan.patch.delegation?.requested_at).toBe(NOW)
    const planned = planHandOver(task({ status: 'planned' }), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    if (!planned.ok) throw new Error(planned.refusal)
    expect(planned.plan.patch).not.toHaveProperty('status')
  })

  it('an open question is never dropped: it goes into the journal and the brief before its wait leaves the task', () => {
    const asked = task({ delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'question', why: 'Count the 07.11. booking as organic?' } })
    const r = planHandOver(asked, { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.patch.waits).toBeNull()
    expect(r.plan.carriedQuestion).toBe('Count the 07.11. booking as organic?')
    expect(r.plan.journal).toContain('Handed over with the open question: "Count the 07.11. booking as organic?"')
    expect(r.plan.brief).toContain('Count the 07.11. booking as organic?')
  })

  it('every plan that clears an open question carries it (the invariant, over all modes)', () => {
    const asked = task({ waitingOn: { who: 'lasse', kind: 'question', why: 'Which list?' } })
    const requests = [
      { mode: 'now', delegate: 'atlas', checkpoint: 'before' },
      { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' } },
      { mode: 'together', delegate: 'atlas', checkpoint: 'after', desk: 'Main' },
    ] as const
    for (const req of requests) {
      const r = planHandOver(asked, req, ctx)
      if (!r.ok) throw new Error(r.refusal)
      expect(r.plan.patch.waits, req.mode).toBeNull()
      expect(r.plan.journal, req.mode).toContain('Which list?')
      expect(r.plan.brief, req.mode).toContain('Which list?')
    }
  })

  it('a review or an outside wait is not a question: it stays', () => {
    const outside = task({ waitingOn: { who: 'kim', kind: 'outside', why: 'reply to the offer' } })
    const r = planHandOver(outside, { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.patch).not.toHaveProperty('waits')
    expect(r.plan.carriedQuestion).toBeUndefined()
  })

  it('carries every open question of the owner and leaves the other waits on the task', () => {
    const review = { id: 's2', who: 'lasse', kind: 'review', why: 'Review: draft', since: '2026-11-19T09:00:00.000Z', session_id: 's2' }
    const outside = { id: 'kim', who: 'kim', kind: 'outside', why: 'reply' }
    const asked = task({ waits: [
      { id: 's1', who: 'lasse', kind: 'question', why: 'Which list?', since: '2026-11-19T08:00:00.000Z', session_id: 's1' },
      review,
      { id: 's3', who: 'lasse', kind: 'question', why: 'Which day?', since: '2026-11-19T08:30:00.000Z', session_id: 's3' },
      outside,
    ] })
    const r = planHandOver(asked, { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.patch.waits).toEqual([review, outside])
    expect(r.plan.carriedQuestion).toBe('Which list? · Which day?')
    expect(r.plan.brief).toContain('Which day?')
  })

  it('schedule: a job on the task at that time, once or repeating', () => {
    const once = planHandOver(task(), { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' } }, ctx)
    if (!once.ok) throw new Error(once.refusal)
    expect(once.plan.job).toEqual({ at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' })
    // the job starts it: no request for the runner
    expect(once.plan.patch.delegation).toEqual({ agent: 'atlas', checkpoint: 'after' })
    expect(once.plan.journal).toBe('Scheduled atlas for 2026-11-20T09:00 (Asia/Singapore) with checkpoint after; the owner stays.')
    const weekly = planHandOver(task(), { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { cron: '0 9 * * 1', timeZone: 'Asia/Singapore' } }, ctx)
    if (!weekly.ok) throw new Error(weekly.refusal)
    expect(weekly.plan.job).toEqual({ cron: '0 9 * * 1', timeZone: 'Asia/Singapore' })
  })

  it('until the goal on a task with a goal is planned as a job', () => {
    const r = planHandOver(task({ goal: 'Shipped' }), { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'UTC', untilGoal: true, session: 'resume' } }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.job).toEqual({ at: '2026-11-20T09:00', timeZone: 'UTC', untilGoal: true, session: 'resume' })
  })

  it('work on it now: a session in the chosen desk, no delegation, a planned task moves to active', () => {
    const r = planHandOver(task(), { mode: 'together', delegate: 'atlas', desk: 'Customers' }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.session).toEqual({ desk: 'Customers' })
    expect(r.plan.patch).toEqual({})
    expect(r.plan.journal).toBe('Working on it with atlas in desk Customers; the owner stays.')
    const delegated = planHandOver(task({ status: 'planned', delegation: { agent: 'motti', checkpoint: 'after', requested_at: NOW } }), { mode: 'together', delegate: 'atlas', desk: 'Customers' }, ctx)
    if (!delegated.ok) throw new Error(delegated.refusal)
    expect(delegated.plan.patch).toEqual({ delegation: null, status: 'active' })
    expect(delegated.plan.journal).toBe('Working on it with atlas in desk Customers; the owner stays. motti is no longer delegated, so it does not go on alone meanwhile.')
  })

  it.each([
    ['a closed task', task({ status: 'resolved' }), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx, 'task_closed'],
    ['an agent of another space', task(), { mode: 'now', delegate: 'scout', checkpoint: 'after' }, ctx, 'delegate_not_in_space'],
    ['no checkpoint', task(), { mode: 'now', delegate: 'atlas' }, ctx, 'checkpoint_required'],
    ['schedule without a time', task(), { mode: 'schedule', delegate: 'atlas', checkpoint: 'after' }, ctx, 'schedule_required'],
    ['work on it now without a desk', task(), { mode: 'together', delegate: 'atlas', checkpoint: 'after' }, ctx, 'desk_required'],
    ['until the goal on a task without a goal', task(), { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'UTC', untilGoal: true } }, ctx, 'goal_required'],
    ['schedule without a checkpoint', task(), { mode: 'schedule', delegate: 'atlas', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' } }, ctx, 'checkpoint_required'],
  ] as const)('refuses %s', (_label, t, req, c, refusal) => {
    expect(planHandOver(t, req as never, c)).toEqual({ ok: false, refusal })
  })
})

describe('planning the undo', () => {
  it('puts the delegation, the open question and the status back and journals it', () => {
    const before = task({ checkpoint: 'before', waitingOn: { who: 'lasse', kind: 'question', why: 'Which list?' } })
    expect(planUndo(before)).toEqual({
      patch: { delegation: null, waits: [{ id: 'waiting_on', who: 'lasse', kind: 'question', why: 'Which list?' }], status: 'active' },
      journal: 'Hand-over undone; the task is back as it was.',
    })
    expect(planUndo(task({ delegate: 'motti', status: 'planned' })).patch).toEqual({ delegation: { agent: 'motti' }, waits: null, status: 'planned' })
    const delegation = { agent: 'motti', checkpoint: 'after', requested_at: NOW, schedule: { cron: '0 9 * * 1' } }
    expect(planUndo(task({ delegate: 'motti', checkpoint: 'after', delegation })).patch.delegation).toEqual(delegation)
  })
})

describe('a scheduled hand-over\'s job', () => {
  it('starts a new worker each run by default; continues the newest session on resume; carries the goal until it is reached', () => {
    expect(scheduledJobOptions({ at: '2026-11-25T09:00', timeZone: 'UTC' }, { goal: 'Shipped' }, 's1'))
      .toEqual({ callerSessionId: null, input: { at: '2026-11-25T09:00', timezone: 'UTC' } })
    expect(scheduledJobOptions({ at: '2026-11-25T09:00', timeZone: 'UTC', session: 'resume', untilGoal: true }, { goal: 'Shipped' }, 's1'))
      .toEqual({ callerSessionId: 's1', input: { at: '2026-11-25T09:00', timezone: 'UTC', target: 'self', goal: 'Shipped' } })
    // resume without a session on the task yet: a new worker; until the goal without a goal: no goal
    expect(scheduledJobOptions({ cron: '0 9 * * 1', timeZone: 'UTC', session: 'resume', untilGoal: true }, {}, null))
      .toEqual({ callerSessionId: null, input: { cron: '0 9 * * 1', timezone: 'UTC' } })
  })
})
