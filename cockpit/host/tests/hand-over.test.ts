import { describe, it, expect } from 'vitest'
import { mirroredHandOver, planHandOver, planUndo, worksAlone, type HandOverTask } from '../src/domain/hand-over.js'

const ctx = { agents: ['atlas', 'motti'] }
const task = (patch: Partial<HandOverTask> = {}): HandOverTask => ({ id: 't1', status: 'active', owner: 'lasse', ...patch })

describe('planning a hand-over', () => {
  it('delegate now: writes the delegation (mode alone), keeps the owner, journals it', () => {
    const r = planHandOver(task({ status: 'planned' }), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.patch).toEqual({ delegation: { agent: 'atlas', checkpoint: 'after', mode: 'alone' } })
    expect(r.plan.patch).not.toHaveProperty('assignee_ids')
    expect(r.plan.journal).toBe('Handed to atlas with checkpoint after; the owner stays.')
    expect(r.plan.job).toBeUndefined()
    expect(r.plan.session).toBeUndefined()
  })

  it('delegate now on an active task puts it back to planned, so the runner starts it', () => {
    const r = planHandOver(task({ status: 'active' }), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.patch.status).toBe('planned')
    const planned = planHandOver(task({ status: 'planned' }), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    if (!planned.ok) throw new Error(planned.refusal)
    expect(planned.plan.patch).not.toHaveProperty('status')
  })

  it('an open question is never dropped: it goes into the journal and the brief before waiting_on clears', () => {
    const asked = task({ delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'question', why: 'Count the 07.11. booking as organic?' } })
    const r = planHandOver(asked, { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.patch.waiting_on).toBeNull()
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
      expect(r.plan.patch.waiting_on, req.mode).toBeNull()
      expect(r.plan.journal, req.mode).toContain('Which list?')
      expect(r.plan.brief, req.mode).toContain('Which list?')
    }
  })

  it('a review or an outside wait is not a question: it stays', () => {
    const outside = task({ waitingOn: { who: 'kim', kind: 'outside', why: 'reply to the offer' } })
    const r = planHandOver(outside, { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.patch).not.toHaveProperty('waiting_on')
    expect(r.plan.carriedQuestion).toBeUndefined()
  })

  it('schedule: a job on the task at that time, once or repeating', () => {
    const once = planHandOver(task(), { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' } }, ctx)
    if (!once.ok) throw new Error(once.refusal)
    expect(once.plan.job).toEqual({ at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' })
    expect(once.plan.journal).toBe('Scheduled atlas for 2026-11-20T09:00 (Asia/Singapore) with checkpoint after; the owner stays.')
    const weekly = planHandOver(task(), { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { cron: '0 9 * * 1', timeZone: 'Asia/Singapore' } }, ctx)
    if (!weekly.ok) throw new Error(weekly.refusal)
    expect(weekly.plan.job).toEqual({ cron: '0 9 * * 1', timeZone: 'Asia/Singapore' })
  })

  it('work on it now: a session in the chosen desk', () => {
    const r = planHandOver(task(), { mode: 'together', delegate: 'atlas', checkpoint: 'after', desk: 'Customers' }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.session).toEqual({ desk: 'Customers' })
    expect(r.plan.journal).toBe('Working on it with atlas in desk Customers; the owner stays.')
  })

  it.each([
    ['a closed task', task({ status: 'resolved' }), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx, 'task_closed'],
    ['an agent of another space', task(), { mode: 'now', delegate: 'scout', checkpoint: 'after' }, ctx, 'delegate_not_in_space'],
    ['no checkpoint', task(), { mode: 'now', delegate: 'atlas' }, ctx, 'checkpoint_required'],
    ['schedule without a time', task(), { mode: 'schedule', delegate: 'atlas', checkpoint: 'after' }, ctx, 'schedule_required'],
    ['work on it now without a desk', task(), { mode: 'together', delegate: 'atlas', checkpoint: 'after' }, ctx, 'desk_required'],
  ] as const)('refuses %s', (_label, t, req, c, refusal) => {
    expect(planHandOver(t, req as never, c)).toEqual({ ok: false, refusal })
  })
})

describe('planning the undo', () => {
  it('puts delegate, checkpoint and the open question back and journals it', () => {
    const before = task({ checkpoint: 'before', waitingOn: { who: 'lasse', kind: 'question', why: 'Which list?' } })
    expect(planUndo(before)).toEqual({
      patch: { delegate: null, checkpoint: 'before', waiting_on: { who: 'lasse', kind: 'question', why: 'Which list?' }, status: 'active' },
      journal: 'Hand-over undone; the task is back as it was.',
    })
    expect(planUndo(task({ delegate: 'motti', status: 'planned' })).patch).toEqual({ delegate: 'motti', checkpoint: null, waiting_on: null, status: 'planned' })
  })
})

describe('delegation mode (schema 23)', () => {
  it('Work on it now writes mode together; Delegate now and Schedule write mode alone', () => {
    const modeOf = (req: Parameters<typeof planHandOver>[1]) => {
      const r = planHandOver(task(), req, ctx)
      return r.ok ? r.plan.patch.delegation?.mode : r.refusal
    }
    expect(modeOf({ mode: 'together', delegate: 'atlas', checkpoint: 'after', desk: 'Main' })).toBe('together')
    expect(modeOf({ mode: 'now', delegate: 'atlas', checkpoint: 'before' })).toBe('alone')
    expect(modeOf({ mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' } })).toBe('alone')
  })

  it('writes one shape: never delegation beside delegate or checkpoint (core refuses both)', () => {
    const r = planHandOver(task(), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.patch).not.toHaveProperty('delegate')
    expect(r.plan.patch).not.toHaveProperty('checkpoint')
  })

  it('undo puts the delegation back as it was, mode and request included', () => {
    const delegation = { agent: 'atlas', checkpoint: 'after', mode: 'together' as const, requested_at: '2026-11-23T10:00:00.000Z' }
    expect(planUndo(task({ delegate: 'atlas', checkpoint: 'after', delegation })).patch).toEqual({ delegation, waiting_on: null, status: 'active' })
  })

  it('mirrors a patch as core does, for showing a pending hand-over', () => {
    expect(mirroredHandOver({ delegation: { agent: 'atlas', checkpoint: 'after', mode: 'alone' } })).toEqual({ delegation: { agent: 'atlas', checkpoint: 'after', mode: 'alone' }, delegate: 'atlas', checkpoint: 'after' })
    expect(mirroredHandOver({ delegation: null })).toEqual({ delegation: null, delegate: null, checkpoint: null })
    expect(mirroredHandOver({ delegate: null, checkpoint: 'before' })).toEqual({ delegate: null, checkpoint: 'before' })
  })

  it('works alone unless the mode says together; no delegation (a brain before 23) counts as alone', () => {
    expect(worksAlone({ properties: { delegation: { mode: 'alone' } } })).toBe(true)
    expect(worksAlone({ properties: { delegation: { mode: 'together' } } })).toBe(false)
    expect(worksAlone({ properties: {} })).toBe(true)
  })
})
