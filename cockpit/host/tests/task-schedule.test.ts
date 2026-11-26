import { describe, it, expect } from 'vitest'
import {
  addCron, clearWake, cronRefusal, dueOf, hasSchedule, nextRunOfSchedule, removeCron, sameSchedule, scheduleOf, ScheduleError, scheduleText,
  setCrons, setEndsAt, setPaused, setWake, withSchedule,
} from '../src/domain/task-schedule.js'
import type { ScheduleFields } from '../src/domain/delegation.js'

const at = (text: string) => Date.parse(text)
const LATE = 6 * 60 * 60_000
// Wednesday 25 November 2026, 10:00 UTC.
const NOW = at('2026-11-25T10:00:00.000Z')
const daily: ScheduleFields = { crons: ['0 8 * * *'], time_zone: 'UTC' }

describe('a task has a schedule', () => {
  const task = (schedule?: ScheduleFields | null) => ({ properties: { delegation: { agent: 'atlas', ...(schedule ? { schedule } : {}) } } })
  it('when its delegation holds a repeating time or a wake-up: the task is the truth', () => {
    expect(hasSchedule(task(daily))).toBe(true)
    expect(hasSchedule(task({ at: '2026-11-26T02:00:00.000Z' }))).toBe(true)
    expect(hasSchedule(task())).toBe(false)
    expect(hasSchedule({})).toBe(false)
    expect(hasSchedule({ properties: null })).toBe(false)
  })
  it('also a paused one, one past its end and one whose wake-up has passed: only ending it takes it off', () => {
    expect(hasSchedule(task({ ...daily, paused: true }))).toBe(true)
    expect(hasSchedule(task({ ...daily, ends_at: '2020-01-01T00:00:00.000Z' }))).toBe(true)
    expect(hasSchedule(task({ at: '2020-01-01T00:00:00.000Z' }))).toBe(true)
  })
  it('not one without any time', () => {
    expect(hasSchedule(task({ crons: [], time_zone: 'UTC' }))).toBe(false)
    expect(scheduleOf(task({ paused: true }))).toBeNull()
  })
})

describe('the next run of a schedule', () => {
  it('is the earliest of the wake-up and each repeating time\'s next one', () => {
    expect(nextRunOfSchedule(daily, NOW)).toBe('2026-11-26T08:00:00.000Z')
    expect(nextRunOfSchedule({ crons: ['0 8 * * *', '0 18 * * *'], time_zone: 'UTC' }, NOW)).toBe('2026-11-25T18:00:00.000Z')
    expect(nextRunOfSchedule({ ...daily, at: '2026-11-25T12:00:00.000Z' }, NOW)).toBe('2026-11-25T12:00:00.000Z')
    expect(nextRunOfSchedule({ ...daily, at: '2026-11-27T12:00:00.000Z' }, NOW)).toBe('2026-11-26T08:00:00.000Z')
    expect(nextRunOfSchedule({ at: '2026-11-27T12:00:00.000Z' }, NOW)).toBe('2026-11-27T12:00:00.000Z')
  })
  it('reads the repeating times in the schedule\'s zone, UTC without one', () => {
    expect(nextRunOfSchedule({ crons: ['0 8 * * *'], time_zone: 'Asia/Makassar' }, NOW)).toBe('2026-11-26T00:00:00.000Z')
    expect(nextRunOfSchedule({ crons: ['0 8 * * *'] }, NOW)).toBe('2026-11-26T08:00:00.000Z')
  })
  it('is none when paused, ended, without a schedule, or with only a wake-up that has passed', () => {
    expect(nextRunOfSchedule({ ...daily, paused: true }, NOW)).toBeNull()
    expect(nextRunOfSchedule({ ...daily, ends_at: '2026-11-25T09:00:00.000Z' }, NOW)).toBeNull()
    // the next time lies after the end
    expect(nextRunOfSchedule({ ...daily, ends_at: '2026-11-26T07:00:00.000Z' }, NOW)).toBeNull()
    expect(nextRunOfSchedule({ ...daily, ends_at: '2026-11-26T08:00:00.000Z' }, NOW)).toBe('2026-11-26T08:00:00.000Z')
    expect(nextRunOfSchedule(null, NOW)).toBeNull()
    expect(nextRunOfSchedule({ at: '2026-11-25T09:00:00.000Z' }, NOW)).toBeNull()
    expect(nextRunOfSchedule({ crons: ['not a cron'] }, NOW)).toBeNull()
  })
})

describe('what of a schedule is due', () => {
  const cursor = '2026-11-25T07:00:00.000Z'
  it('a repeating time whose first time after the cursor has come fires, and the cursor moves to now', () => {
    expect(dueOf(daily, { cursor }, NOW, LATE)).toEqual({
      firing: { dueAt: '2026-11-25T08:00:00.000Z', wake: null, crons: [{ cron: '0 8 * * *', dueAt: '2026-11-25T08:00:00.000Z' }] },
      missed: [], cursor: '2026-11-25T10:00:00.000Z',
    })
  })
  it('nothing is due before its time, and then the cursor stays: a pass with nothing due changes nothing', () => {
    expect(dueOf(daily, { cursor: '2026-11-25T08:00:00.000Z' }, NOW, LATE)).toEqual({ firing: null, missed: [], cursor: '2026-11-25T08:00:00.000Z' })
  })
  it('a schedule seen for the first time is due from now on: no repeating time of the past fires', () => {
    expect(dueOf(daily, {}, NOW, LATE)).toEqual({ firing: null, missed: [], cursor: '2026-11-25T10:00:00.000Z' })
    expect(dueOf(daily, { cursor: null }, NOW, LATE).firing).toBeNull()
  })
  it('several times due at once are one firing that names all of them, due at the earliest', () => {
    const schedule: ScheduleFields = { crons: ['0 8 * * *', '30 9 * * *', '0 18 * * *'], at: '2026-11-25T09:00:00.000Z', why: 'Check the reply', by_session: 's1', time_zone: 'UTC' }
    expect(dueOf(schedule, { cursor }, NOW, LATE)).toEqual({
      firing: {
        dueAt: '2026-11-25T08:00:00.000Z',
        wake: { at: '2026-11-25T09:00:00.000Z', why: 'Check the reply', bySession: 's1' },
        crons: [{ cron: '0 8 * * *', dueAt: '2026-11-25T08:00:00.000Z' }, { cron: '30 9 * * *', dueAt: '2026-11-25T09:30:00.000Z' }],
      },
      missed: [], cursor: '2026-11-25T10:00:00.000Z',
    })
  })
  it('a repeating time later than the late limit is missed, not run; one cron gives one time per pass', () => {
    // down for two days: 23 and 24 November 08:00 passed, and today's
    const due = dueOf(daily, { cursor: '2026-11-23T07:00:00.000Z' }, NOW, LATE)
    expect(due).toEqual({ firing: null, missed: [{ cron: '0 8 * * *', dueAt: '2026-11-23T08:00:00.000Z' }], cursor: '2026-11-25T10:00:00.000Z' })
    // exactly at the limit it still runs
    expect(dueOf(daily, { cursor }, at('2026-11-25T14:00:00.000Z'), LATE).firing?.crons).toHaveLength(1)
    expect(dueOf(daily, { cursor }, at('2026-11-25T14:00:00.001Z'), LATE)).toMatchObject({ firing: null, missed: [{ cron: '0 8 * * *' }] })
  })
  it('a missed repeating time next to one in time: the one in time fires, the other is recorded', () => {
    const due = dueOf({ crons: ['0 1 * * *', '0 9 * * *'], time_zone: 'UTC' }, { cursor: '2026-11-25T00:00:00.000Z' }, NOW, LATE)
    expect(due.firing?.crons).toEqual([{ cron: '0 9 * * *', dueAt: '2026-11-25T09:00:00.000Z' }])
    expect(due.missed).toEqual([{ cron: '0 1 * * *', dueAt: '2026-11-25T01:00:00.000Z' }])
  })
  it('the wake-up fires once its time has come, however late and whatever the cursor, and only once', () => {
    const wake: ScheduleFields = { at: '2026-11-20T09:00:00.000Z', why: 'Look again' }
    expect(dueOf(wake, {}, NOW, LATE)).toEqual({
      firing: { dueAt: '2026-11-20T09:00:00.000Z', wake: { at: '2026-11-20T09:00:00.000Z', why: 'Look again', bySession: null }, crons: [] },
      missed: [], cursor: '2026-11-25T10:00:00.000Z',
    })
    // the write that clears it failed: the one fired last does not fire again, in whatever form its time is written
    expect(dueOf(wake, { cursor, firedWake: '2026-11-20T09:00:00Z' }, NOW, LATE).firing).toBeNull()
    // a new wake-up after it does
    expect(dueOf({ at: '2026-11-25T09:30:00.000Z' }, { cursor, firedWake: '2026-11-20T09:00:00.000Z' }, NOW, LATE).firing?.wake?.at).toBe('2026-11-25T09:30:00.000Z')
    expect(dueOf({ at: '2026-11-25T10:00:00.000Z' }, { cursor }, NOW, LATE).firing?.wake).not.toBeNull()
    expect(dueOf({ at: '2026-11-25T10:00:00.001Z' }, { cursor }, NOW, LATE).firing).toBeNull()
  })
  it('a wake-up alone leaves the cursor where it is', () => {
    expect(dueOf({ ...daily, at: '2026-11-25T09:00:00.000Z' }, { cursor: '2026-11-25T08:30:00.000Z' }, NOW, LATE)).toMatchObject({ firing: { crons: [] }, cursor: '2026-11-25T08:30:00.000Z' })
  })
  it('a paused schedule and one past its end are never due, and nothing from that time is made up afterwards', () => {
    const both: ScheduleFields = { ...daily, at: '2026-11-25T09:00:00.000Z' }
    expect(dueOf({ ...both, paused: true }, { cursor }, NOW, LATE)).toEqual({ firing: null, missed: [], cursor: '2026-11-25T10:00:00.000Z' })
    expect(dueOf({ ...both, ends_at: '2026-11-25T09:59:00.000Z' }, { cursor }, NOW, LATE)).toEqual({ firing: null, missed: [], cursor: '2026-11-25T10:00:00.000Z' })
    // at its end it still fires
    expect(dueOf({ ...both, ends_at: '2026-11-25T10:00:00.000Z' }, { cursor }, NOW, LATE).firing).not.toBeNull()
  })
  it('no schedule, and a cron that is none, are never due', () => {
    expect(dueOf(null, { cursor }, NOW, LATE).firing).toBeNull()
    expect(dueOf({ crons: ['every day'], at: '2026-11-26T00:00:00.000Z' }, { cursor }, NOW, LATE)).toMatchObject({ firing: null, missed: [] })
  })
})

describe('editing a schedule', () => {
  const full: ScheduleFields = { crons: ['0 8 * * *'], at: '2026-11-26T02:00:00.000Z', why: 'Check the reply', by_session: 's1', time_zone: 'Europe/Berlin', paused: true, ends_at: '2027-01-01T00:00:00.000Z' }

  it('setting the wake-up replaces the wake-up and never touches a repeating time', () => {
    expect(setWake(null, { at: '2026-11-27T02:00:00Z', why: 'Look again', bySession: 's2' })).toEqual({ at: '2026-11-27T02:00:00.000Z', why: 'Look again', by_session: 's2' })
    expect(setWake(full, { at: '2026-11-27T02:00:00+01:00' })).toEqual({ crons: ['0 8 * * *'], at: '2026-11-27T01:00:00.000Z', time_zone: 'Europe/Berlin', paused: true, ends_at: '2027-01-01T00:00:00.000Z' })
    // a zone is taken only when the schedule names none
    expect(setWake(null, { at: '2026-11-27T02:00:00Z', timeZone: 'Asia/Makassar' }).time_zone).toBe('Asia/Makassar')
    expect(setWake(full, { at: '2026-11-27T02:00:00Z', timeZone: 'Asia/Makassar' }).time_zone).toBe('Europe/Berlin')
    expect(() => setWake(null, { at: 'soon' })).toThrow(ScheduleError)
  })
  it('a reason longer than the brain takes is cut', () => {
    expect(setWake(null, { at: '2026-11-27T02:00:00Z', why: 'x'.repeat(2500) }).why).toHaveLength(2000)
  })
  it('clearing the wake-up takes its reason and session with it and keeps the repeating times; nothing left is no schedule', () => {
    expect(clearWake(full)).toEqual({ crons: ['0 8 * * *'], time_zone: 'Europe/Berlin', paused: true, ends_at: '2027-01-01T00:00:00.000Z' })
    expect(clearWake({ at: '2026-11-26T02:00:00.000Z', why: 'x', time_zone: 'UTC' })).toBeNull()
    expect(clearWake(null)).toBeNull()
  })
  it('clearing it for one session only clears a wake-up that session set', () => {
    expect(clearWake(full, { onlyBySession: 's2' })).toEqual(full)
    expect(clearWake(full, { onlyBySession: 's1' })?.at).toBeUndefined()
    // one nobody's session set is not that session's
    expect(clearWake({ at: '2026-11-26T02:00:00.000Z' }, { onlyBySession: 's1' })).toEqual({ at: '2026-11-26T02:00:00.000Z' })
  })
  it('adding a repeating time checks it, adds it once and keeps everything else', () => {
    expect(addCron(null, '0 8 * * 1-5', 'Europe/Berlin')).toEqual({ crons: ['0 8 * * 1-5'], time_zone: 'Europe/Berlin' })
    expect(addCron(full, ' 0 18 * * * ')).toEqual({ ...full, crons: ['0 8 * * *', '0 18 * * *'] })
    expect(addCron(full, '0 8 * * *')).toEqual(full)
    expect(() => addCron(full, '0 25 * * *')).toThrow('cron: hour: "25" is not between 0 and 23')
    expect(() => addCron(full, 'daily')).toThrow(ScheduleError)
  })
  it('all of a task\'s repeating times are read in one zone: the first one sets it, a later one joins it', () => {
    expect(addCron({ at: '2026-11-26T02:00:00.000Z', time_zone: 'UTC' }, '0 8 * * *', 'Asia/Makassar').time_zone).toBe('Asia/Makassar')
    expect(addCron(full, '0 18 * * *', 'Asia/Makassar').time_zone).toBe('Europe/Berlin')
    expect(addCron({ crons: ['0 8 * * *'] }, '0 18 * * *', 'Asia/Makassar').time_zone).toBe('Asia/Makassar')
  })
  it('a task holds at most ten repeating times', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `0 ${i} * * *`)
    expect(() => addCron({ crons: ten }, '0 18 * * *')).toThrow('a task has at most 10 repeating times; remove one first')
    expect(addCron({ crons: ten }, '0 3 * * *').crons).toHaveLength(10)
    expect(() => setCrons(null, [...ten, '0 18 * * *'])).toThrow(ScheduleError)
  })
  it('removing a repeating time keeps the rest; the last one of a schedule without a wake-up leaves no schedule', () => {
    expect(removeCron({ crons: ['0 8 * * *', '0 18 * * *'], time_zone: 'UTC' }, '0 8 * * *')).toEqual({ crons: ['0 18 * * *'], time_zone: 'UTC' })
    expect(removeCron({ crons: ['0 8 * * *'], time_zone: 'UTC', paused: true }, '0 8 * * *')).toBeNull()
    expect(removeCron(full, '0 8 * * *')).toEqual({ at: '2026-11-26T02:00:00.000Z', why: 'Check the reply', by_session: 's1', time_zone: 'Europe/Berlin', paused: true, ends_at: '2027-01-01T00:00:00.000Z' })
    expect(removeCron(full, '0 9 * * *')).toEqual(full)
    expect(removeCron(null, '0 8 * * *')).toBeNull()
  })
  it('replacing all repeating times keeps the wake-up; none left and no wake-up is no schedule', () => {
    expect(setCrons(full, ['0 9 * * *', '0 9 * * *', '0 17 * * *'])?.crons).toEqual(['0 9 * * *', '0 17 * * *'])
    expect(setCrons(full, ['0 9 * * *'], 'Asia/Makassar')?.time_zone).toBe('Asia/Makassar')
    expect(setCrons(full, [])).toEqual({ at: '2026-11-26T02:00:00.000Z', why: 'Check the reply', by_session: 's1', time_zone: 'Europe/Berlin', paused: true, ends_at: '2027-01-01T00:00:00.000Z' })
    expect(setCrons({ crons: ['0 8 * * *'] }, [])).toBeNull()
    expect(() => setCrons(full, ['0 9 * * *', 'x'])).toThrow(ScheduleError)
  })
  it('pause and resume hold for the whole schedule', () => {
    expect(setPaused({ crons: ['0 8 * * *'] }, true)).toEqual({ crons: ['0 8 * * *'], paused: true })
    expect(setPaused(full, false)?.paused).toBeUndefined()
    expect(setPaused(null, true)).toBeNull()
  })
  it('an end is set as an instant and taken off with null', () => {
    expect(setEndsAt({ crons: ['0 8 * * *'] }, '2027-01-01T00:00:00+01:00')).toEqual({ crons: ['0 8 * * *'], ends_at: '2026-12-31T23:00:00.000Z' })
    expect(setEndsAt(full, null)?.ends_at).toBeUndefined()
    expect(setEndsAt(null, '2027-01-01T00:00:00Z')).toBeNull()
    expect(() => setEndsAt(full, 'never')).toThrow(ScheduleError)
  })
  it('a schedule comes out with its keys in the brain\'s order, and why and by_session only with a wake-up', () => {
    const mixed = setPaused({ paused: false, time_zone: 'UTC', why: 'x', by_session: 's1', crons: ['0 8 * * *'] } as ScheduleFields, true)
    expect(JSON.stringify(mixed)).toBe('{"crons":["0 8 * * *"],"time_zone":"UTC","paused":true}')
    expect(Object.keys(setWake(setEndsAt(mixed, '2027-01-01T00:00:00Z'), { at: '2026-11-27T02:00:00Z', why: 'y', bySession: 's2' }))).toEqual(['crons', 'at', 'why', 'by_session', 'time_zone', 'paused', 'ends_at'])
  })
})

describe('a repeating time that cannot be taken', () => {
  const gap = 15 * 60_000
  it('is not a cron, never fires, or fires too often', () => {
    expect(cronRefusal('0 8 * * 1-5', 'UTC', NOW, gap)).toBeNull()
    expect(cronRefusal('*/15 * * * *', 'UTC', NOW, gap)).toBeNull()
    expect(cronRefusal('0 8 * *', 'UTC', NOW, gap)).toBe('cron: cron needs five fields: minute hour day-of-month month day-of-week')
    expect(cronRefusal('0 0 31 2 *', 'UTC', NOW, gap)).toBe('that cron never fires')
    expect(cronRefusal('*/10 * * * *', 'UTC', NOW, gap)).toBe('that cron fires every 10 min; at most every 15 min')
  })
})

describe('a schedule in a delegation and in words', () => {
  it('the delegation carries a schedule along unchanged, or loses it with null', () => {
    const d = { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-25T00:00:00.000Z', schedule: daily }
    expect(withSchedule(d, { at: '2026-11-26T02:00:00Z' })).toEqual({ agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-25T00:00:00.000Z', schedule: { at: '2026-11-26T02:00:00.000Z' } })
    expect(withSchedule(d, null)).toEqual({ agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-25T00:00:00.000Z' })
    expect(withSchedule({ agent: 'atlas' }, daily)).toEqual({ agent: 'atlas', schedule: daily })
    // a schedule without a time is none: the brain refuses crons: []
    expect(withSchedule(d, { crons: [], paused: true })).not.toHaveProperty('schedule')
  })
  it('two schedules are the same whatever the key order or the form of their times', () => {
    expect(sameSchedule({ at: '2026-11-26T02:00:00Z', crons: ['0 8 * * *'] }, { crons: ['0 8 * * *'], at: '2026-11-26T02:00:00.000Z' })).toBe(true)
    expect(sameSchedule(null, undefined)).toBe(true)
    expect(sameSchedule(null, { crons: [] })).toBe(true)
    expect(sameSchedule(daily, { ...daily, paused: true })).toBe(false)
    expect(sameSchedule(daily, { crons: ['0 8 * * *', '0 9 * * *'], time_zone: 'UTC' })).toBe(false)
    expect(sameSchedule({ at: '2026-11-26T02:00:00Z', why: 'a' }, { at: '2026-11-26T02:00:00Z', why: 'b' })).toBe(false)
  })
  it('reads as one line', () => {
    expect(scheduleText({ crons: ['0 13 * * 1-5', '0 18,22 * * 1-5'], at: '2026-11-27T02:00:00.000Z', time_zone: 'Asia/Makassar', paused: true })).toBe('0 13 * * 1-5; 0 18,22 * * 1-5 (Asia/Makassar), wake-up 2026-11-27T02:00:00.000Z, paused')
    expect(scheduleText(null)).toBe('none')
  })
})
