import { describe, it, expect } from 'vitest'
import { createTurnWake, NO_TASK, scheduleAfterTurn, TASK_CLOSED } from '../src/application/turn-wake.js'
import type { ScheduledTask } from '../src/application/task-schedule-write.js'
import type { ScheduleFields } from '../src/domain/delegation.js'

const NOW = Date.parse('2026-11-25T08:00:00Z')
const ZONE = 'Asia/Bangkok' // UTC+7
const WEEKDAYS: ScheduleFields = { crons: ['0 8 * * 1-5'], time_zone: 'Asia/Makassar' }
const WHY = 'The check you set with end_turn is due. You planned: look again. See where the task stands and act on it.'

/** A brain that keeps one task and applies each track call's delegation to it, as the real one does. */
function world(opts: { schedule?: ScheduleFields | null; status?: string; taskId?: string | null; known?: boolean; noBrain?: boolean; failing?: boolean; delegation?: boolean } = {}) {
  const task: ScheduledTask = {
    id: 't1', status: opts.status ?? 'active',
    properties: opts.delegation === false ? {} : { delegation: { agent: 'atlas', checkpoint: 'after', ...(opts.schedule ? { schedule: opts.schedule } : {}) } },
  }
  const posts: Array<Record<string, unknown>> = []
  const log: string[] = []
  let changed = 0
  const brain = {
    async get() { if (opts.failing) throw new Error('the brain does not answer'); return structuredClone(task) },
    async post(_path: string, body: Record<string, unknown>) {
      posts.push(body)
      if (body.delegation) task.properties = { ...task.properties, delegation: body.delegation as never }
      return {}
    },
  }
  const wake = createTurnWake({
    where: () => (opts.known === false ? null : { taskId: opts.taskId === undefined ? 't1' : opts.taskId, brain: opts.noBrain ? null : brain, agent: 'atlas' }),
    zone: () => ZONE, now: () => NOW, log: (line) => log.push(line), changed: () => { changed += 1 },
  })
  const schedule = () => task.properties?.delegation?.schedule ?? null
  return { wake, posts, log, schedule, changed: () => changed }
}

const set = (when: string) => ({ edit: { kind: 'set' as const, when }, why: WHY })
const clear = (whose: 'any' | 'own') => ({ edit: { kind: 'clear' as const, whose }, why: WHY })

describe('the task\'s schedule after a turn\'s end', () => {
  it('a time sets the wake-up with its reason and the session, replaces the one before and never touches a repeating time', () => {
    const first = scheduleAfterTurn(WEEKDAYS, { kind: 'set', when: '2026-11-26T10:00' }, { sessionId: 's1', at: '2026-11-26T03:00:00.000Z', why: WHY, zone: ZONE })
    expect(first).toEqual({ crons: ['0 8 * * 1-5'], at: '2026-11-26T03:00:00.000Z', why: WHY, by_session: 's1', time_zone: 'Asia/Makassar' })
    const second = scheduleAfterTurn(first, { kind: 'set', when: '2026-11-27T10:00' }, { sessionId: 's2', at: '2026-11-27T03:00:00.000Z', why: 'Other.', zone: ZONE })
    expect(second).toEqual({ crons: ['0 8 * * 1-5'], at: '2026-11-27T03:00:00.000Z', why: 'Other.', by_session: 's2', time_zone: 'Asia/Makassar' })
    // A task without a schedule gets one that holds only the wake-up, read in the user's zone.
    expect(scheduleAfterTurn(null, { kind: 'set', when: '2026-11-26T10:00' }, { sessionId: 's1', at: '2026-11-26T03:00:00.000Z', why: WHY, zone: ZONE }))
      .toEqual({ at: '2026-11-26T03:00:00.000Z', why: WHY, by_session: 's1', time_zone: ZONE })
  })

  it('an end without a time clears only the wake-up this session set; a hand-over clears it whoever set it', () => {
    const mine = { ...WEEKDAYS, at: '2026-11-26T03:00:00.000Z', why: WHY, by_session: 's1' }
    const by = { sessionId: 's1', why: WHY, zone: ZONE }
    expect(scheduleAfterTurn(mine, { kind: 'clear', whose: 'own' }, by)).toEqual(WEEKDAYS)
    expect(scheduleAfterTurn(mine, { kind: 'clear', whose: 'own' }, { ...by, sessionId: 's2' })).toEqual(mine)
    expect(scheduleAfterTurn(mine, { kind: 'clear', whose: 'any' }, { ...by, sessionId: 's2' })).toEqual(WEEKDAYS)
    // A wake-up nobody's session set (the board's scheduled hand-over) stays through an end without a time.
    const { by_session: _none, ...theirs } = mine
    expect(scheduleAfterTurn(theirs, { kind: 'clear', whose: 'own' }, by)).toEqual(theirs)
    // Nothing is left of a schedule that held only the wake-up.
    expect(scheduleAfterTurn({ at: '2026-11-26T03:00:00.000Z', by_session: 's1' }, { kind: 'clear', whose: 'own' }, by)).toBeNull()
  })
})

describe('a turn\'s end and the wake-up of the session\'s task', () => {
  it('writes the wake-up next to the task\'s repeating time, read in the user\'s zone, and answers with the instant saved', async () => {
    const w = world({ schedule: WEEKDAYS })
    const settled = await w.wake.settle('s1', set('2026-11-26T10:00'))
    expect(settled).toEqual({ problem: null, saved: { at: Date.parse('2026-11-26T03:00:00Z'), zone: ZONE }, nextRun: true })
    expect(w.schedule()).toEqual({ crons: ['0 8 * * 1-5'], at: '2026-11-26T03:00:00.000Z', why: WHY, by_session: 's1', time_zone: 'Asia/Makassar' })
    // One write of the whole delegation: the agent and the checkpoint stay.
    expect(w.posts).toEqual([{ delegation: { agent: 'atlas', checkpoint: 'after', schedule: w.schedule() } }])
    expect(w.changed()).toBe(1)
    expect(w.log).toEqual(['[wake] s1 task t1: wake-up set for 2026-11-26T10:00 (Asia/Bangkok) = 2026-11-26T03:00:00.000Z'])
  })

  it('another time replaces the wake-up: the task never holds two', async () => {
    const w = world({ schedule: WEEKDAYS })
    await w.wake.settle('s1', set('2026-11-26T10:00'))
    const settled = await w.wake.settle('s1', set('2026-11-27T15:30'))
    expect(settled.saved).toEqual({ at: Date.parse('2026-11-27T08:30:00Z'), zone: ZONE })
    expect(w.schedule()).toMatchObject({ crons: ['0 8 * * 1-5'], at: '2026-11-27T08:30:00.000Z', by_session: 's1' })
  })

  it('a hand-over to the owner clears the wake-up whoever set it and keeps the repeating time', async () => {
    const w = world({ schedule: { ...WEEKDAYS, at: '2026-11-26T03:00:00.000Z', why: WHY, by_session: 'another' } })
    expect(await w.wake.settle('s1', clear('any'))).toEqual({ problem: null, saved: null, nextRun: true })
    expect(w.schedule()).toEqual(WEEKDAYS)
    expect(w.log).toEqual(['[wake] s1 task t1: wake-up cleared'])
  })

  it('an end without a time clears its own wake-up and leaves another session\'s, writing nothing then', async () => {
    const own = world({ schedule: { at: '2026-11-26T03:00:00.000Z', why: WHY, by_session: 's1' } })
    // The wake-up was all its schedule held: none is left, and the task has no next run.
    expect(await own.wake.settle('s1', clear('own'))).toEqual({ problem: null, saved: null, nextRun: false })
    expect(own.schedule()).toBeNull()
    const other = world({ schedule: { at: '2026-11-26T03:00:00.000Z', why: WHY, by_session: 'another' } })
    // Another session's wake-up still ahead is a next run: this session needs no time.
    expect(await other.wake.settle('s1', clear('own'))).toEqual({ problem: null, saved: null, nextRun: true })
    expect(other.posts).toEqual([])
    expect(other.changed()).toBe(0)
  })

  it('says whether the task has a next run once the call is applied', async () => {
    const run = async (schedule: ScheduleFields | null) => (await world({ schedule }).wake.settle('s1', clear('own'))).nextRun
    expect(await run(null)).toBe(false)
    expect(await run(WEEKDAYS)).toBe(true)
    expect(await run({ ...WEEKDAYS, paused: true })).toBe(false)
    expect(await run({ ...WEEKDAYS, ends_at: '2026-11-25T07:00:00.000Z' })).toBe(false)
    // A wake-up that has passed is not ahead.
    expect(await run({ at: '2026-11-25T07:00:00.000Z' })).toBe(false)
    expect(await run({ at: '2026-11-25T09:00:00.000Z' })).toBe(true)
    // Its own wake-up is cleared by the very call, so it is no next run.
    expect(await run({ at: '2026-11-25T09:00:00.000Z', by_session: 's1' })).toBe(false)
  })

  it('gives a task without a delegation one for the space\'s agent with its wake-up', async () => {
    const w = world({ delegation: false })
    await w.wake.settle('s1', set('2026-11-26T10:00'))
    expect(w.posts).toEqual([{ delegation: { agent: 'atlas', schedule: { at: '2026-11-26T03:00:00.000Z', why: WHY, by_session: 's1', time_zone: ZONE } } }])
  })

  it('refuses the time of a session without a task, with the reason and nothing to try again', async () => {
    const w = world({ taskId: null })
    expect(await w.wake.settle('s1', set('2026-11-26T10:00'))).toEqual({ problem: NO_TASK, fix: 'none', saved: null, nextRun: false })
    expect(NO_TASK).toBe('this session works on no task, and a wake-up is set on a task')
    // Without a time there is nothing to refuse, and nothing to say.
    expect(await w.wake.settle('s1', clear('own'))).toEqual({ problem: null, saved: null, nextRun: false })
    expect(w.posts).toEqual([])
    expect(w.log).toEqual(['[wake] s1 wake-up not set: this session works on no task, and a wake-up is set on a task'])
    expect((await world({ known: false }).wake.settle('s1', set('2026-11-26T10:00'))).problem).toBe('the cockpit does not know this session')
  })

  it('sets no wake-up on a closed task, and leaves its schedule alone', async () => {
    const w = world({ status: 'resolved', schedule: { at: '2026-11-26T03:00:00.000Z', by_session: 's1' } })
    expect(await w.wake.settle('s1', set('2026-11-27T10:00'))).toEqual({ problem: TASK_CLOSED, fix: 'none', saved: null, nextRun: false })
    expect(await w.wake.settle('s1', clear('any'))).toEqual({ problem: null, saved: null, nextRun: false })
    expect(w.posts).toEqual([])
  })

  it('refuses a time more than a year ahead and one that is no time, asking for another', async () => {
    const w = world()
    expect(await w.wake.settle('s1', set('2028-01-01T10:00'))).toMatchObject({ problem: 'at most a year ahead', fix: 'time', saved: null })
    expect(await w.wake.settle('s1', set('soon'))).toMatchObject({ problem: '"soon" is not a time', fix: 'time' })
    expect(w.posts).toEqual([])
  })

  it('reports a write that failed, as a call to make again; a failed clear is only logged', async () => {
    const w = world({ failing: true })
    expect(await w.wake.settle('s1', set('2026-11-26T10:00')))
      .toEqual({ problem: 'the task\'s schedule could not be written (the brain does not answer)', fix: 'again', saved: null, nextRun: false })
    expect(await w.wake.settle('s1', clear('own'))).toEqual({ problem: null, saved: null, nextRun: false })
    expect(w.log).toEqual(['[wake] s1 wake-up not set: the brain does not answer', '[wake] s1 wake-up not cleared: the brain does not answer'])
    expect((await world({ noBrain: true }).wake.settle('s1', set('2026-11-26T10:00'))).fix).toBe('again')
  })
})
