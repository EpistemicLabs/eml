import { describe, it, expect } from 'vitest'
import { formatInZone } from '../src/domain/schedule.js'
import { continuedBrief, planHandOver, planUndo, readScheduleSpec, type HandOverTask } from '../src/domain/hand-over.js'

const NOW = '2026-11-24T10:00:00.000Z'
const ctx = { agents: ['atlas', 'motti'], now: NOW }
// A task ready to hand over has a name and a goal.
const task = (patch: Partial<HandOverTask> = {}): HandOverTask => ({ id: 't1', status: 'active', owner: 'lasse', title: 'fix-sync', goal: 'Orders sync', ...patch })

describe('planning a hand-over', () => {
  it('delegate now: writes the delegation with its request, keeps the owner, journals it', () => {
    const r = planHandOver(task({ status: 'planned' }), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.patch).toEqual({ delegation: { agent: 'atlas', checkpoint: 'after', requested_at: NOW } })
    expect(r.plan.patch).not.toHaveProperty('assignee_ids')
    expect(r.plan.journal).toBe('Handed to atlas with checkpoint after; the owner stays.')
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
    expect(planHandOver(task(), { mode: 'together', delegate: 'atlas' }, ctx)).toEqual({ ok: false, refusal: 'no_session' })
  })

  it('a placeholder task the agent named is ready once it has a goal; working on it yourself needs neither', () => {
    expect(planHandOver(task({ title: 'session-2026-11-25-2ee4035f', displayTitle: 'Fix the sync' }), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx).ok).toBe(true)
    expect(planHandOver(task({ goal: undefined, title: 'session-2026-11-25-2ee4035f' }), { mode: 'together', delegate: 'atlas', desk: 'Main' }, ctx).ok).toBe(true)
  })

  it('a continued session reads that it asked the carried question itself', () => {
    expect(continuedBrief('Count it?')).toBe('Your question was still open when the owner delegated this task: "Count it?". Settle it yourself where you can; ask it again only if only the owner can answer it.')
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

  it('schedule: one time is the task\'s wake-up for the delegate, a repeat rule one of its repeating times; the delegation holds no schedule and no request for the runner', () => {
    const once = planHandOver(task(), { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-25T01:00:00.000Z', timeZone: 'Asia/Singapore' } }, ctx)
    if (!once.ok) throw new Error(once.refusal)
    // its schedule starts it: no request for the runner
    expect(once.plan.patch.delegation).toEqual({ agent: 'atlas', checkpoint: 'after' })
    // the wake-up is the delegate's: it checks back then
    expect(once.plan.patch.schedule).toEqual({ at: '2026-11-25T01:00:00.000Z', by: 'atlas', time_zone: 'Asia/Singapore' })
    // The journal line is the task's status line on the board: the time as people read it, in the zone it was given in.
    expect(once.plan.journal).toBe(`Scheduled atlas for ${formatInZone(Date.parse('2026-11-25T01:00:00.000Z'), 'Asia/Singapore')} (Asia/Singapore) with checkpoint after; the owner stays.`)
    expect(once.plan.journal).toMatch(/^Scheduled atlas for Wed 25 Nov( 2026)? 09:00 \(Asia\/Singapore\) with/)
    expect(once.plan.journal).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    const weekly = planHandOver(task(), { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { cron: '0 9 * * 1', timeZone: 'Asia/Singapore' } }, ctx)
    if (!weekly.ok) throw new Error(weekly.refusal)
    expect(weekly.plan.patch.delegation).toEqual({ agent: 'atlas', checkpoint: 'after' })
    expect(weekly.plan.patch.schedule).toEqual({ crons: ['0 9 * * 1'], time_zone: 'Asia/Singapore' })
    expect(weekly.plan.journal).toBe('Scheduled atlas every Monday at 09:00 (Asia/Singapore) with checkpoint after; the owner stays.')
    // a rule the words do not fit is named as it is
    const odd = planHandOver(task(), { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { cron: '*/20 * * * *', timeZone: 'UTC' } }, ctx)
    expect(odd.ok && odd.plan.journal).toBe('Scheduled atlas for "*/20 * * * *" (UTC) with checkpoint after; the owner stays.')
  })

  it('schedule on a task that has a schedule: a wake-up replaces its wake-up (now the delegate\'s) and keeps the repeating times; a repeat rule joins them once', () => {
    const has = task({ delegation: { agent: 'motti', checkpoint: 'none' }, schedule: { crons: ['0 8 * * *'], at: '2026-11-24T12:00:00.000Z', why: 'Check the reply', by: 'motti', by_session: 's1', time_zone: 'Europe/Berlin' } })
    const once = planHandOver(has, { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-25T01:00:00.000Z', timeZone: 'Asia/Singapore' } }, ctx)
    if (!once.ok) throw new Error(once.refusal)
    expect(once.plan.patch.delegation).toEqual({ agent: 'atlas', checkpoint: 'after' })
    expect(once.plan.patch.schedule).toEqual({ crons: ['0 8 * * *'], at: '2026-11-25T01:00:00.000Z', by: 'atlas', time_zone: 'Europe/Berlin' })
    // repeating times without a zone are read in UTC: a wake-up given in the page's zone does not give them that zone
    const bare = task({ delegation: { agent: 'motti', checkpoint: 'none' }, schedule: { crons: ['0 8 * * *'] } })
    const woken = planHandOver(bare, { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-25T01:00:00.000Z', timeZone: 'Asia/Singapore' } }, ctx)
    if (!woken.ok) throw new Error(woken.refusal)
    expect(woken.plan.patch.schedule).toEqual({ crons: ['0 8 * * *'], at: '2026-11-25T01:00:00.000Z', by: 'atlas' })
    // a repeating time added leaves the wake-up as it was, with whom it is for
    const more = planHandOver(has, { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { cron: '0 18 * * *', timeZone: 'Europe/Berlin' } }, ctx)
    if (!more.ok) throw new Error(more.refusal)
    expect(more.plan.patch.schedule).toEqual({ crons: ['0 8 * * *', '0 18 * * *'], at: '2026-11-24T12:00:00.000Z', why: 'Check the reply', by: 'motti', by_session: 's1', time_zone: 'Europe/Berlin' })
    const same = planHandOver(has, { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { cron: '0 8 * * *', timeZone: 'Europe/Berlin' } }, ctx)
    if (!same.ok) throw new Error(same.refusal)
    expect(same.plan.patch.schedule?.crons).toEqual(['0 8 * * *'])
    const full = task({ delegation: { agent: 'motti' }, schedule: { crons: Array.from({ length: 10 }, (_, i) => `0 ${i} * * *`) } })
    expect(planHandOver(full, { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { cron: '0 18 * * *', timeZone: 'UTC' } }, ctx)).toEqual({ ok: false, refusal: 'schedule_invalid' })
  })

  it('a schedule left in the delegation (before schema 25) is not the task\'s: a hand-over plans from the task\'s own schedule only', () => {
    const old = task({ delegation: { agent: 'motti', schedule: { crons: ['0 8 * * *'] } } as never })
    const r = planHandOver(old, { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-25T01:00:00.000Z', timeZone: 'UTC' } }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.patch.schedule).toEqual({ at: '2026-11-25T01:00:00.000Z', by: 'atlas', time_zone: 'UTC' })
  })

  it('a repeating time given in another zone than the task\'s repeating times is refused, by the schedule tool\'s rule', () => {
    const berlin = task({ delegation: { agent: 'motti' }, schedule: { crons: ['0 8 * * *'], time_zone: 'Europe/Berlin' } })
    const cron = (t: HandOverTask, timeZone: string) => planHandOver(t, { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { cron: '0 18 * * *', timeZone } }, ctx)
    expect(cron(berlin, 'Asia/Singapore')).toEqual({ ok: false, refusal: 'schedule_zone', message: 'Times of this task are in Europe/Berlin, and this one was given in Asia/Singapore: give it in Europe/Berlin.' })
    expect(cron(berlin, 'Europe/Berlin').ok).toBe(true)
    // A wake-up is an instant: its zone never matters. A task with only a wake-up has no zone to join.
    expect(planHandOver(berlin, { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-25T01:00:00.000Z', timeZone: 'Asia/Singapore' } }, ctx).ok).toBe(true)
    const wakeOnly = task({ schedule: { at: '2026-11-24T12:00:00.000Z', time_zone: 'Europe/Berlin' } })
    const first = cron(wakeOnly, 'Asia/Singapore')
    if (!first.ok) throw new Error(first.refusal)
    expect(first.plan.patch.schedule).toMatchObject({ crons: ['0 18 * * *'], time_zone: 'Asia/Singapore' })
  })

  it('the schedule is the task\'s, not the delegation\'s: delegate now and work on it now leave it untouched, and a wake-up stays', () => {
    const schedule = { crons: ['0 8 * * *'], at: '2026-11-26T09:00:00.000Z', by: 'motti', time_zone: 'Europe/Berlin' }
    const has = task({ delegate: 'motti', checkpoint: 'after', delegation: { agent: 'motti', checkpoint: 'after', requested_at: '2026-11-20T00:00:00.000Z' }, schedule })
    const now = planHandOver(has, { mode: 'now', delegate: 'atlas', checkpoint: 'none' }, ctx)
    if (!now.ok) throw new Error(now.refusal)
    expect(now.plan.patch).toEqual({ delegation: { agent: 'atlas', checkpoint: 'none', requested_at: NOW } })
    expect(now.plan.patch).not.toHaveProperty('schedule')
    const together = planHandOver(has, { mode: 'together', delegate: 'atlas', desk: 'Main' }, ctx)
    if (!together.ok) throw new Error(together.refusal)
    // the delegation goes; the schedule, its wake-up too, is not part of the patch and so stays as it is
    expect(together.plan.patch).toEqual({ delegation: null })
    expect(together.plan.journal).toBe('Working on it with atlas in desk Main; the owner stays. motti is no longer delegated, so it does not go on alone meanwhile. Its schedule stays.')
    // without a schedule the delegation goes in the same way, and nothing is said of one
    const plain = planHandOver(task({ delegate: 'motti', delegation: { agent: 'motti', checkpoint: 'after' } }), { mode: 'together', delegate: 'atlas', desk: 'Main' }, ctx)
    if (!plain.ok) throw new Error(plain.refusal)
    expect(plain.plan.patch).toEqual({ delegation: null })
    expect(plain.plan.journal).not.toContain('schedule')
    // a task with a schedule and no delegation: work on it now writes nothing to the task
    const undelegated = planHandOver(task({ schedule }), { mode: 'together', delegate: 'atlas', desk: 'Main' }, ctx)
    if (!undelegated.ok) throw new Error(undelegated.refusal)
    expect(undelegated.plan.patch).toEqual({})
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
    ['delegate now on a task without a goal', task({ goal: undefined }), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx, 'not_ready'],
    ['delegate now on a placeholder task', task({ title: 'session-2026-11-25-2ee4035f' }), { mode: 'now', delegate: 'atlas', checkpoint: 'after' }, ctx, 'not_ready'],
    ['schedule on a task without a goal', task({ goal: '  ' }), { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'UTC' } }, ctx, 'not_ready'],
    ['work on it now without a desk', task(), { mode: 'together', delegate: 'atlas', checkpoint: 'after' }, ctx, 'no_session'],
    ['schedule without a checkpoint', task(), { mode: 'schedule', delegate: 'atlas', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' } }, ctx, 'checkpoint_required'],
  ] as const)('refuses %s', (_label, t, req, c, refusal) => {
    expect(planHandOver(t, req as never, c)).toEqual({ ok: false, refusal })
  })
})

describe('planning the undo', () => {
  it('puts the delegation, the schedule, the open question and the status back and journals it', () => {
    const before = task({ checkpoint: 'before', waitingOn: { who: 'lasse', kind: 'question', why: 'Which list?' } })
    expect(planUndo(before)).toEqual({
      patch: { delegation: null, schedule: null, waits: [{ id: 'waiting_on', who: 'lasse', kind: 'question', why: 'Which list?' }], status: 'active' },
      journal: 'Hand-over undone; the task is back as it was.',
    })
    expect(planUndo(task({ delegate: 'motti', status: 'planned' })).patch).toEqual({ delegation: { agent: 'motti' }, schedule: null, waits: null, status: 'planned' })
    const delegation = { agent: 'motti', checkpoint: 'after', requested_at: NOW }
    const schedule = { crons: ['0 9 * * 1'], at: '2026-11-26T09:00:00.000Z', by: 'motti' }
    expect(planUndo(task({ delegate: 'motti', checkpoint: 'after', delegation, schedule })).patch).toMatchObject({ delegation, schedule })
  })

  it('undoes a scheduled hand-over: the wake-up it set goes, the schedule the task had before comes back', () => {
    const before = task({ schedule: { crons: ['0 8 * * *'], time_zone: 'UTC' } })
    const r = planHandOver(before, { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-25T01:00:00.000Z', timeZone: 'UTC' } }, ctx)
    if (!r.ok) throw new Error(r.refusal)
    expect(r.plan.patch.schedule).toMatchObject({ at: '2026-11-25T01:00:00.000Z', by: 'atlas' })
    expect(planUndo(before).patch).toMatchObject({ delegation: null, schedule: { crons: ['0 8 * * *'], time_zone: 'UTC' } })
    // a task that had none gets none back
    expect(planUndo(task()).patch.schedule).toBeNull()
  })
})

describe('a hand-over\'s schedule as the page sends it', () => {
  const now = Date.parse(NOW)
  const limits = { minGapMs: 15 * 60_000, maxAheadMs: 366 * 24 * 60 * 60_000 }
  it('reads one time in its zone as an instant, and a repeat rule as it is; what the page sent before (until the goal, the session choice) is left out', () => {
    expect(readScheduleSpec({ at: '2026-11-25T09:00', timeZone: 'Asia/Singapore' }, now, limits)).toEqual({ at: '2026-11-25T01:00:00.000Z', timeZone: 'Asia/Singapore' })
    expect(readScheduleSpec({ at: '2026-11-25T09:00:00Z', timeZone: 'Asia/Singapore' }, now, limits)).toEqual({ at: '2026-11-25T09:00:00.000Z', timeZone: 'Asia/Singapore' })
    expect(readScheduleSpec({ cron: '0 9 * * 1', timeZone: 'UTC', untilGoal: true, session: 'resume' }, now, limits)).toEqual({ cron: '0 9 * * 1', timeZone: 'UTC' })
  })
  it('is none without a zone or a time, or with both a time and a rule', () => {
    expect(readScheduleSpec(undefined, now, limits)).toBeUndefined()
    expect(readScheduleSpec({ at: '2026-11-25T09:00' }, now, limits)).toBeUndefined()
    expect(readScheduleSpec({ timeZone: 'UTC' }, now, limits)).toBeUndefined()
    expect(readScheduleSpec({ timeZone: 'UTC', at: '2026-11-25T09:00', cron: '0 9 * * 1' }, now, limits)).toBeUndefined()
  })
  it('says what is wrong with a time, a rule or a zone', () => {
    expect(readScheduleSpec({ at: 'tomorrow', timeZone: 'UTC' }, now, limits)).toEqual({ error: 'at: "tomorrow" is not a date and time; write it like 2026-11-13T10:00 (read in UTC)' })
    expect(readScheduleSpec({ at: '2026-11-24T09:00', timeZone: 'UTC' }, now, limits)).toMatchObject({ error: expect.stringContaining('has passed') })
    expect(readScheduleSpec({ at: '2028-11-24T09:00', timeZone: 'UTC' }, now, limits)).toEqual({ error: 'at: at most a year ahead' })
    expect(readScheduleSpec({ cron: '0 9 * *', timeZone: 'UTC' }, now, limits)).toEqual({ error: 'cron: cron needs five fields: minute hour day-of-month month day-of-week' })
    expect(readScheduleSpec({ cron: '*/5 * * * *', timeZone: 'UTC' }, now, limits)).toEqual({ error: 'that cron fires every 5 min; at most every 15 min' })
    expect(readScheduleSpec({ cron: '0 9 * * 1', timeZone: 'Mars/Olympus' }, now, limits)).toMatchObject({ error: expect.stringContaining('unknown time zone') })
  })
})
