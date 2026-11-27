import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { plainJson, type OpEnvelope } from '@engramprotocol/protocol/log'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION, initDatabase, mostUrgentWait } from '../src'
import { fieldProblem } from '../src/fields'
import { mirrorTaskState } from '../src/task-state'
import { scheduleText } from '../src/commands/task-track'
import { uuidv5 } from '../src/log/op'
import { readObject } from '../src/objects'
import { createObject, updateObject, validNote, validTask, writes } from './fixtures'

// Schema 23 (task state): a task's delegation and waits, mirrored with the flat
// delegate/checkpoint and waiting_on on every write (src/task-state.ts), and the
// run object, which only the member it names writes (src/runs.ts).

describe('task.delegation mirrors delegate and checkpoint', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })
  afterEach(() => eml.close())

  const props = (id: string) => eml.engrams.getRaw(id)!.properties as Record<string, any>
  const changes = (id: string) => eml.engrams.entries(id, ['change']).map(e => e.text)
  const task = (properties: Record<string, unknown> = {}) => writes(eml).store(validTask({ scope: 'project.eml', properties }))

  it('a task created with the flat fields gets a delegation, requested at its creation when it has a checkpoint', () => {
    const t = task({ delegate: 'atlas', checkpoint: 'after' })
    expect(props(t.id).delegation).toEqual({ agent: 'atlas', checkpoint: 'after', requested_at: props(t.id).delegation.requested_at })
    expect(props(t.id).delegation.requested_at).toBe(eml.engrams.getRaw(t.id)!.created_at)
  })

  it('a task created with a delegate but no checkpoint, or with a schedule, is not requested', () => {
    expect(props(task({ delegate: 'atlas' }).id).delegation).toEqual({ agent: 'atlas' })
    const scheduled = task({ delegation: { agent: 'atlas', checkpoint: 'after' }, schedule: { at: '2026-11-28T10:00:00Z' } })
    expect(props(scheduled.id).delegation).toEqual({ agent: 'atlas', checkpoint: 'after' })
    expect(props(scheduled.id).schedule).toEqual({ at: '2026-11-28T10:00:00.000Z' })
  })

  it('a task created with a delegation gets the flat fields, timestamps as stored', () => {
    const t = task({ delegation: { agent: 'atlas', checkpoint: 'before', requested_at: '2026-11-23' } })
    expect(props(t.id)).toMatchObject({
      delegate: 'atlas', checkpoint: 'before',
      delegation: { agent: 'atlas', checkpoint: 'before', requested_at: '2026-11-23T00:00:00.000Z' },
    })
    // the stored keys are in one order, whatever order the caller sent
    const u = task({ delegation: { requested_at: '2026-11-23', checkpoint: 'before', agent: 'atlas' } })
    expect(Object.keys(props(u.id).delegation)).toEqual(['agent', 'checkpoint', 'requested_at'])
  })

  it('a checkpoint without a delegate has no delegation', () => {
    const t = task({ checkpoint: 'before' })
    expect(props(t.id).delegation).toBeUndefined()
    expect(props(t.id).checkpoint).toBe('before')
  })

  it('a flat write keeps requested_at while the agent stays, and leaves the schedule alone', () => {
    const schedule = { crons: ['0 9 * * 1'], at: '2026-11-24T08:00:00.000Z', why: 'look again', by: 'atlas', by_session: 'sess-1' }
    const t = task({ delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-23T10:00:00.000Z' }, schedule })
    writes(eml).trackTask(t.id, { checkpoint: 'none' })
    expect(props(t.id).delegation).toEqual({ agent: 'atlas', checkpoint: 'none', requested_at: '2026-11-23T10:00:00.000Z' })
    writes(eml).trackTask(t.id, { checkpoint: null })
    expect(props(t.id).delegation).toEqual({ agent: 'atlas', requested_at: '2026-11-23T10:00:00.000Z' })
    expect(props(t.id).schedule).toEqual(schedule)
    expect(changes(t.id).filter(c => c.startsWith('schedule'))).toEqual([])
  })

  it('a flat write with a new agent starts unrequested and leaves the schedule as it is', () => {
    const schedule = { crons: ['0 9 * * 1'], at: '2026-11-24T08:00:00.000Z', why: 'look again', by: 'atlas', by_session: 'sess-1', time_zone: 'Asia/Makassar', paused: true, ends_at: '2026-12-31T00:00:00.000Z' }
    const t = task({ delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-23T10:00:00.000Z' }, schedule })
    writes(eml).trackTask(t.id, { delegate: 'motti' })
    expect(props(t.id).delegation).toEqual({ agent: 'motti', checkpoint: 'after' })
    expect(props(t.id).schedule).toEqual(schedule)
    expect(changes(t.id)).toEqual(expect.arrayContaining(['delegate atlas → motti', 'delegation request cleared']))
    expect(changes(t.id).filter(c => c.startsWith('schedule'))).toEqual([])
  })

  it('a new agent on a task without a schedule gets none', () => {
    const t = task({ delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-23T10:00:00.000Z' } })
    writes(eml).trackTask(t.id, { delegate: 'motti' })
    expect(props(t.id).delegation).toEqual({ agent: 'motti', checkpoint: 'after' })
    expect(props(t.id).schedule).toBeUndefined()
  })

  it('clearing the delegate, or the delegation, keeps the schedule', () => {
    const a = task({ delegation: { agent: 'atlas' }, schedule: { crons: ['0 9 * * 1'] } })
    writes(eml).trackTask(a.id, { delegate: null })
    expect(props(a.id).delegation).toBeUndefined()
    expect(props(a.id).schedule).toEqual({ crons: ['0 9 * * 1'] })
    const b = task({ delegation: { agent: 'atlas' }, schedule: { at: '2026-11-28', by: 'atlas' } })
    writes(eml).trackTask(b.id, { delegation: null })
    expect(props(b.id).delegation).toBeUndefined()
    expect(props(b.id).schedule).toEqual({ at: '2026-11-28T00:00:00.000Z', by: 'atlas' })
    expect(changes(b.id).filter(c => c.startsWith('schedule'))).toEqual([])
  })

  it('clearing the delegate clears the delegation; the checkpoint stays as written', () => {
    const t = task({ delegate: 'atlas', checkpoint: 'after' })
    writes(eml).trackTask(t.id, { delegate: null })
    expect(props(t.id).delegation).toBeUndefined()
    expect(props(t.id).checkpoint).toBe('after')
  })

  it('a delegation write sets the flat fields; null takes all three back', () => {
    const t = task({ checkpoint: 'none' })
    writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', requested_at: '2026-11-23T10:00:00.000Z' } })
    // the delegation carries no checkpoint, so the flat one is cleared to match
    expect(props(t.id)).toMatchObject({ delegate: 'atlas' })
    expect(props(t.id).checkpoint).toBeUndefined()
    writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-23T10:00:00.000Z' } })
    expect(changes(t.id)).toEqual(expect.arrayContaining(['delegate none → atlas', 'delegation requested', 'checkpoint none → after']))
    writes(eml).trackTask(t.id, { delegation: null })
    const p = props(t.id)
    expect([p.delegate, p.checkpoint, p.delegation]).toEqual([undefined, undefined, undefined])
  })

  it('refuses both shapes in one call and a delegation that is not its shape', () => {
    const t = task()
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas' }, checkpoint: 'after' })).toThrow('not both')
    expect(() => writes(eml).trackTask(t.id, { delegation: { checkpoint: 'after' } })).toThrow('delegation needs agent.')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', mode: 'alone' } })).toThrow('delegation has unknown key mode')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: ' ' } })).toThrow('delegation.agent must not be blank.')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', requested_at: 'soon' } })).toThrow('delegation.requested_at must be an ISO date')
    expect(() => writes(eml).trackTask(t.id, { delegation: 'atlas' })).toThrow('delegation must be an object')
    expect(() => writes(eml).trackTask(t.id, { schedule: { crons: ['0 8 * * *'], paused: 'yes' } })).toThrow('schedule.paused must be true or false.')
    expect(() => writes(eml).store(validTask({ scope: 'project.eml', properties: { delegation: { agent: 'atlas' }, delegate: 'motti' } }))).toThrow('not both')
  })
})

// Schema 24: a task's schedule is its repeating times (crons) and at most one
// wake-up (at, with why and by_session). Schema 25: it is the task's own field
// (not its delegation's), and the wake-up names who it is for (by).
describe('task.schedule (schema 24, 25)', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })
  afterEach(() => eml.close())

  const props = (id: string) => eml.engrams.getRaw(id)!.properties as Record<string, any>
  const changes = (id: string) => eml.engrams.entries(id, ['change']).map(e => e.text)
  const task = (properties: Record<string, unknown> = {}) => writes(eml).store(validTask({ scope: 'project.eml', properties }))
  const scheduled = (schedule: unknown) => task({ delegation: { agent: 'atlas' }, schedule })
  const stored = (schedule: unknown) => props(scheduled(schedule).id).schedule
  const NEEDS_A_TIME = 'Invalid engram: schedule needs a repeating time (crons) or a wake-up (at).'

  it('holds repeating times alone', () => {
    expect(stored({ crons: ['0 13 * * 1-5', '0 18,22 * * 1-5'] })).toEqual({ crons: ['0 13 * * 1-5', '0 18,22 * * 1-5'] })
  })

  it('holds a wake-up alone', () => {
    expect(stored({ at: '2026-11-27T02:00:00.000Z' })).toEqual({ at: '2026-11-27T02:00:00.000Z' })
  })

  it('holds both: a wake-up next to the repeating times', () => {
    expect(stored({ crons: ['0 13 * * 1-5'], at: '2026-11-27T02:00:00.000Z' })).toEqual({ crons: ['0 13 * * 1-5'], at: '2026-11-27T02:00:00.000Z' })
  })

  it('refuses a schedule with neither a repeating time nor a wake-up', () => {
    expect(() => scheduled({})).toThrow(NEEDS_A_TIME)
    expect(() => scheduled({ time_zone: 'Asia/Makassar', paused: true, ends_at: '2026-12-31' })).toThrow(NEEDS_A_TIME)
    expect(() => scheduled({ why: 'look again', by_session: 'sess-1' })).toThrow(NEEDS_A_TIME)
  })

  it('stores its keys in one order, whatever order the caller sent', () => {
    const s = stored({ ends_at: '2026-12-31T00:00:00.000Z', paused: false, time_zone: 'Asia/Makassar', by_session: 'sess-1', by: 'atlas', why: 'look again', at: '2026-11-27T02:00:00.000Z', crons: ['0 13 * * 1-5'] })
    expect(Object.keys(s)).toEqual(['crons', 'at', 'why', 'by', 'by_session', 'time_zone', 'paused', 'ends_at'])
    expect(s).toEqual({ crons: ['0 13 * * 1-5'], at: '2026-11-27T02:00:00.000Z', why: 'look again', by: 'atlas', by_session: 'sess-1', time_zone: 'Asia/Makassar', paused: false, ends_at: '2026-12-31T00:00:00.000Z' })
  })

  it('stores at as ISO-8601 UTC with milliseconds', () => {
    expect(stored({ at: '2026-11-27' }).at).toBe('2026-11-27T00:00:00.000Z')
    expect(stored({ at: '2026-11-27T10:00:00+08:00' }).at).toBe('2026-11-27T02:00:00.000Z')
  })

  it('stores ends_at as ISO-8601 UTC with milliseconds', () => {
    expect(stored({ crons: ['0 8 * * *'], ends_at: '2026-12-31' }).ends_at).toBe('2026-12-31T00:00:00.000Z')
    expect(stored({ crons: ['0 8 * * *'], ends_at: '2026-12-31T08:00:00+08:00' }).ends_at).toBe('2026-12-31T00:00:00.000Z')
  })

  it('stores crons without the white space around an entry, in the order given', () => {
    expect(stored({ crons: [' 0 18 * * * ', '0 8 * * *\n'] }).crons).toEqual(['0 18 * * *', '0 8 * * *'])
  })

  it('stores each cron once, keeping the first place', () => {
    const patch: Record<string, unknown> = { schedule: { crons: ['0 18 * * *', '0 8 * * *', ' 0 18 * * * ', '0 8 * * *'] } }
    mirrorTaskState({}, patch)
    expect(patch.schedule).toEqual({ crons: ['0 18 * * *', '0 8 * * *'] })
  })

  it('refuses a cron that occurs twice, also when only the white space around it differs', () => {
    expect(() => scheduled({ crons: ['0 8 * * *', '0 8 * * *'] })).toThrow('schedule.crons: 0 8 * * * occurs twice.')
    expect(() => scheduled({ crons: ['0 8 * * *', ' 0 8 * * * '] })).toThrow('schedule.crons: 0 8 * * * occurs twice.')
  })

  it('refuses a blank cron', () => {
    expect(() => scheduled({ crons: ['0 8 * * *', ' '] })).toThrow('schedule.crons[1] must not be blank.')
    expect(() => scheduled({ crons: [''], at: '2026-11-27' })).toThrow('schedule.crons[0] must not be blank.')
  })

  it('refuses an empty list of crons, also next to a wake-up: without a repeating time the key is left out', () => {
    expect(() => scheduled({ crons: [] })).toThrow('schedule.crons takes 1 to 10 entries (got 0).')
    expect(() => scheduled({ crons: [], at: '2026-11-27' })).toThrow('schedule.crons takes 1 to 10 entries (got 0).')
  })

  it('takes ten crons and refuses an eleventh', () => {
    const crons = (n: number) => Array.from({ length: n }, (_, i) => `${i} 8 * * *`)
    expect(stored({ crons: crons(10) }).crons).toHaveLength(10)
    expect(() => scheduled({ crons: crons(11) })).toThrow('schedule.crons takes 1 to 10 entries (got 11).')
  })

  it('refuses crons that are not a list of text', () => {
    expect(() => scheduled({ crons: '0 8 * * *' })).toThrow('schedule.crons must be a list of text.')
    expect(() => scheduled({ crons: [8] })).toThrow('schedule.crons must be a list of text.')
  })

  it('keeps why, by and by_session with the wake-up', () => {
    expect(stored({ at: '2026-11-27T02:00:00.000Z', why: 'check whether the customer answered', by: 'atlas', by_session: 'sess-1' }))
      .toEqual({ at: '2026-11-27T02:00:00.000Z', why: 'check whether the customer answered', by: 'atlas', by_session: 'sess-1' })
  })

  it('drops why, by and by_session when there is no wake-up', () => {
    expect(stored({ crons: ['0 8 * * *'], why: 'check whether the customer answered', by: 'atlas', by_session: 'sess-1' })).toEqual({ crons: ['0 8 * * *'] })
  })

  it('refuses a blank by', () => {
    expect(() => scheduled({ at: '2026-11-27', by: ' ' })).toThrow('schedule.by must not be blank.')
  })

  it('takes a why of 2000 characters and refuses a longer one', () => {
    expect(stored({ at: '2026-11-27', why: 'x'.repeat(2000) }).why).toHaveLength(2000)
    expect(() => scheduled({ at: '2026-11-27', why: 'x'.repeat(2001) })).toThrow('schedule.why is at most 2000 characters (got 2001).')
  })

  it('refuses the keys of schema 23, cron and session, like any unknown key', () => {
    expect(() => scheduled({ cron: '0 8 * * *' })).toThrow('schedule has unknown key cron (it takes crons, at, why, by, by_session, time_zone, paused, ends_at).')
    expect(() => scheduled({ crons: ['0 8 * * *'], session: 'new' })).toThrow('schedule has unknown key session')
    expect(() => scheduled({ at: '2026-11-27', next_run_at: '2026-11-27' })).toThrow('schedule has unknown key next_run_at')
  })

  it('refuses values that are not their kind: at and ends_at dates, paused a bool, time_zone not blank, text as text', () => {
    expect(() => scheduled({ at: 'tomorrow' })).toThrow('schedule.at must be an ISO date')
    expect(() => scheduled({ at: '2026-11-27', ends_at: 'never' })).toThrow('schedule.ends_at must be an ISO date')
    expect(() => scheduled({ at: '2026-11-27', paused: 'yes' })).toThrow('schedule.paused must be true or false.')
    expect(() => scheduled({ crons: ['0 8 * * *'], time_zone: ' ' })).toThrow('schedule.time_zone must not be blank.')
    expect(() => scheduled({ at: '2026-11-27', by_session: 7 })).toThrow('schedule.by_session must be text.')
    expect(() => scheduled({ at: '2026-11-27', why: null })).toThrow('schedule.why is left out, not null.')
  })

  it('a task with a schedule is not requested at its creation', () => {
    const t = task({ delegation: { agent: 'atlas', checkpoint: 'after' }, schedule: { crons: ['0 8 * * *'] } })
    expect(props(t.id).delegation.requested_at).toBeUndefined()
  })

  it('setting a wake-up next to the repeating times is one schedule write; clearing it keeps the crons', () => {
    const t = scheduled({ crons: ['0 13 * * 1-5'], time_zone: 'Asia/Makassar' })
    writes(eml).trackTask(t.id, { schedule: { crons: ['0 13 * * 1-5'], time_zone: 'Asia/Makassar', at: '2026-11-27T02:00:00Z', why: 'look again', by_session: 'sess-1' } })
    writes(eml).trackTask(t.id, { schedule: { crons: ['0 13 * * 1-5'], time_zone: 'Asia/Makassar' } })
    expect(props(t.id).schedule).toEqual({ crons: ['0 13 * * 1-5'], time_zone: 'Asia/Makassar' })
    expect(changes(t.id).filter(c => c.startsWith('schedule'))).toEqual([
      'schedule crons 0 13 * * 1-5 (Asia/Makassar) → crons 0 13 * * 1-5 (Asia/Makassar), at 2026-11-27T02:00:00.000Z',
      'schedule crons 0 13 * * 1-5 (Asia/Makassar), at 2026-11-27T02:00:00.000Z → crons 0 13 * * 1-5 (Asia/Makassar)',
    ])
  })

  it('journals a schedule change as schedule <old> → <new>; a change of only the wake-up\'s reason or session gets no entry', () => {
    const t = scheduled({ at: '2026-11-27T02:00:00.000Z', why: 'look again', by_session: 'sess-1' })
    expect(changes(t.id).filter(c => c.startsWith('schedule'))).toEqual([])
    writes(eml).trackTask(t.id, { schedule: { at: '2026-11-27T02:00:00.000Z', why: 'look once more', by_session: 'sess-2' } })
    expect(props(t.id).schedule).toEqual({ at: '2026-11-27T02:00:00.000Z', why: 'look once more', by_session: 'sess-2' })
    expect(changes(t.id).filter(c => c.startsWith('schedule'))).toEqual([])
    writes(eml).trackTask(t.id, { schedule: { at: '2026-11-27T02:00:00.000Z', paused: true } })
    expect(changes(t.id).filter(c => c.startsWith('schedule'))).toEqual(['schedule at 2026-11-27T02:00:00.000Z → at 2026-11-27T02:00:00.000Z (paused)'])
  })

  it('a schedule written at schema 25 inside the delegation is refused: it is the task\'s own field', () => {
    expect(() => task({ delegation: { agent: 'atlas', schedule: { crons: ['0 8 * * *'] } } })).toThrow('delegation has unknown key schedule')
  })

  it('a schedule needs no delegation: a person\'s reminder on a task nobody works on', () => {
    const t = task({ schedule: { at: '2026-11-27T02:00:00.000Z', by: 'ada', why: 'call the vendor' } })
    expect(props(t.id).delegation).toBeUndefined()
    expect(props(t.id).schedule).toEqual({ at: '2026-11-27T02:00:00.000Z', why: 'call the vendor', by: 'ada' })
  })

  it('taking a task back from its agent (delegation null) leaves the schedule alone', () => {
    const t = scheduled({ at: '2026-11-27T02:00:00.000Z', by: 'atlas', by_session: 'sess-1', crons: ['0 8 * * *'] })
    writes(eml).trackTask(t.id, { delegation: null })
    expect(props(t.id).delegation).toBeUndefined()
    expect(props(t.id).schedule).toEqual({ crons: ['0 8 * * *'], at: '2026-11-27T02:00:00.000Z', by: 'atlas', by_session: 'sess-1' })
  })

  it('a new agent leaves the schedule alone, the session that set the wake-up too', () => {
    const t = scheduled({ at: '2026-11-27T02:00:00.000Z', by: 'atlas', by_session: 'sess-1' })
    writes(eml).trackTask(t.id, { delegate: 'motti' })
    expect(props(t.id).delegation).toEqual({ agent: 'motti' })
    expect(props(t.id).schedule).toEqual({ at: '2026-11-27T02:00:00.000Z', by: 'atlas', by_session: 'sess-1' })
  })

  it('a schedule write leaves the delegation alone; null ends the schedule', () => {
    const t = task({ delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-26T08:00:00.000Z' } })
    writes(eml).trackTask(t.id, { schedule: { at: '2026-11-27T02:00:00.000Z', by: 'atlas' } })
    expect(props(t.id).delegation).toEqual({ agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-26T08:00:00.000Z' })
    writes(eml).trackTask(t.id, { schedule: null })
    expect(props(t.id).schedule).toBeUndefined()
    expect(changes(t.id).filter(c => c.startsWith('schedule'))).toEqual([
      'schedule none → at 2026-11-27T02:00:00.000Z by atlas',
      'schedule at 2026-11-27T02:00:00.000Z by atlas → none',
    ])
  })

  it('a new owner of the wake-up is a change', () => {
    const t = scheduled({ at: '2026-11-27T02:00:00.000Z', by: 'atlas' })
    writes(eml).trackTask(t.id, { schedule: { at: '2026-11-27T02:00:00.000Z', by: 'ada' } })
    expect(changes(t.id).filter(c => c.startsWith('schedule'))).toEqual(['schedule at 2026-11-27T02:00:00.000Z by atlas → at 2026-11-27T02:00:00.000Z by ada'])
  })
})

// Schema 25: a wait can be a do (the person's own step) and carry a due date.
describe('task.waits do and due (schema 25)', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })
  afterEach(() => eml.close())

  const props = (id: string) => eml.engrams.getRaw(id)!.properties as Record<string, any>
  const task = (properties: Record<string, unknown> = {}) => writes(eml).store(validTask({ scope: 'project.eml', properties }))

  it('a do sorts above a review and below a stopped run', () => {
    const t = task({ waits: [
      { id: 'r', who: 'ada', kind: 'review' },
      { id: 'd', who: 'ada', kind: 'do', why: 'call the vendor' },
    ] })
    expect(props(t.id).waiting_on).toEqual({ who: 'ada', kind: 'do', why: 'call the vendor' })
    writes(eml).trackTask(t.id, { waits: [...props(t.id).waits, { id: 's', who: 'ada', kind: 'stopped' }] })
    expect(props(t.id).waiting_on.kind).toBe('stopped')
  })

  it('keeps a due date as given and a due time as ISO-8601 UTC with milliseconds; waiting_on carries it', () => {
    const t = task({ waits: [{ due: '2026-11-28', id: 'd', who: 'ada', kind: 'do' }, { id: 'o', who: 'outside:vendor', kind: 'outside', due: '2026-11-28T10:00:00+01:00' }] })
    expect(props(t.id).waits).toEqual([
      { id: 'd', who: 'ada', kind: 'do', due: '2026-11-28' },
      { id: 'o', who: 'outside:vendor', kind: 'outside', due: '2026-11-28T09:00:00.000Z' },
    ])
    expect(props(t.id).waiting_on).toEqual({ who: 'ada', kind: 'do', due: '2026-11-28' })
  })

  it('refuses a due that is no date', () => {
    expect(() => task({ waits: [{ id: 'd', who: 'ada', kind: 'do', due: 'friday' }] })).toThrow('waits[0].due must be an ISO date')
  })
})

describe('scheduleText — a schedule as one journal word group', () => {
  it('is none without a schedule', () => {
    expect(scheduleText(undefined)).toBe('none')
  })
  it('names the crons, their time zone, the wake-up and paused', () => {
    expect(scheduleText({ crons: ['0 13 * * 1-5', '0 18,22 * * 1-5'], at: '2026-11-27T02:00:00.000Z', why: 'look again', by_session: 's', time_zone: 'Asia/Makassar', paused: true }))
      .toBe('crons 0 13 * * 1-5; 0 18,22 * * 1-5 (Asia/Makassar), at 2026-11-27T02:00:00.000Z (paused)')
  })
  it('names crons alone, without a time zone when there is none', () => {
    expect(scheduleText({ crons: ['0 8 * * *'] })).toBe('crons 0 8 * * *')
  })
  it('names who the wake-up is for (schema 25)', () => {
    expect(scheduleText({ at: '2026-11-27T02:00:00.000Z', by: 'atlas', by_session: 's' })).toBe('at 2026-11-27T02:00:00.000Z by atlas')
  })
  it('names a wake-up alone, and no time zone with it: the zone is the crons\'', () => {
    expect(scheduleText({ at: '2026-11-27T02:00:00.000Z', time_zone: 'Asia/Makassar' })).toBe('at 2026-11-27T02:00:00.000Z')
  })
  it('names the end', () => {
    expect(scheduleText({ crons: ['0 8 * * *'], ends_at: '2026-12-31T00:00:00.000Z', paused: false })).toBe('crons 0 8 * * *, ends 2026-12-31T00:00:00.000Z')
  })
})

describe('a text[] field with entries (schema 24)', () => {
  const spec = { kind: 'text[]', entries: { min: 1, max: 3 } } as const
  it('takes a list within its bounds', () => {
    expect(fieldProblem('f', spec, ['a'])).toBeNull()
    expect(fieldProblem('f', spec, ['a', 'b', 'c'])).toBeNull()
  })
  it('refuses fewer or more entries than it takes', () => {
    expect(fieldProblem('f', spec, [])).toBe('f takes 1 to 3 entries (got 0).')
    expect(fieldProblem('f', spec, ['a', 'b', 'c', 'd'])).toBe('f takes 1 to 3 entries (got 4).')
  })
  it('refuses a blank entry', () => {
    expect(fieldProblem('f', spec, ['a', '  '])).toBe('f[1] must not be blank.')
  })
  it('refuses an entry that occurs twice, read without the white space around it', () => {
    expect(fieldProblem('f', spec, ['a', 'b', ' a'])).toBe('f: a occurs twice.')
  })
  it('a text[] without entries stays unbounded, as before', () => {
    expect(fieldProblem('f', { kind: 'text[]' }, [])).toBeNull()
    expect(fieldProblem('f', { kind: 'text[]' }, ['a', 'a', ''])).toBeNull()
  })
})

describe('task.waits and waiting_on', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })
  afterEach(() => eml.close())

  const props = (id: string) => eml.engrams.getRaw(id)!.properties as Record<string, any>
  const changes = (id: string) => eml.engrams.entries(id, ['change']).map(e => e.text)
  const task = () => writes(eml).store(validTask({ scope: 'project.eml' }))

  it('waiting_on is the most urgent wait: a question above a review, then the oldest, without its id', () => {
    const t = task()
    writes(eml).trackTask(t.id, { waits: [
      { id: 'a', who: 'lasse', kind: 'review', why: 'look', since: '2026-11-23T08:00:00.000Z', session_id: 'a' },
      { id: 'b', who: 'lasse', kind: 'question', why: 'which?', since: '2026-11-23T10:00:00.000Z', session_id: 'b' },
      { id: 'c', who: 'dominik', kind: 'question', why: 'which too?', since: '2026-11-23T09:00:00Z', session_id: 'c' },
    ] })
    expect(props(t.id).waiting_on).toEqual({ who: 'dominik', kind: 'question', why: 'which too?', since: '2026-11-23T09:00:00.000Z', session_id: 'c' })
    expect(props(t.id).waits).toHaveLength(3)
    expect(changes(t.id)).toEqual(expect.arrayContaining(['waits → lasse · review, lasse · question, dominik · question', 'waiting on nobody → dominik · which too?']))
  })

  it('a parked wait ranks after every wait that is not, and waiting_on leaves its snooze out', () => {
    const t = task()
    writes(eml).trackTask(t.id, { waits: [
      { id: 'a', who: 'lasse', kind: 'question', snoozed_until: '2026-11-30' },
      { id: 'b', who: 'lasse', kind: 'outside', why: 'vendor' },
    ] })
    expect(props(t.id).waiting_on).toEqual({ who: 'lasse', kind: 'outside', why: 'vendor' })
    expect(props(t.id).waits[0].snoozed_until).toBe('2026-11-30T00:00:00.000Z')
    writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'lasse', kind: 'question', snoozed_until: 'open' }] })
    expect(props(t.id).waiting_on).toEqual({ who: 'lasse', kind: 'question' })
    expect(props(t.id).waits[0].snoozed_until).toBe('open')
    expect(() => writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'lasse', snoozed_until: 'someday' }] })).toThrow('snoozed_until is an ISO date or "open"')
  })

  it('a wait without a kind ranks after every kind; equal ones keep list order', () => {
    expect(mostUrgentWait([{ id: 'x', who: 'a' }, { id: 'y', who: 'b', kind: 'outside' }])?.id).toBe('y')
    expect(mostUrgentWait([{ id: 'x', who: 'a', kind: 'go' }, { id: 'y', who: 'b', kind: 'go' }])?.id).toBe('x')
    expect(mostUrgentWait([])).toBeUndefined()
  })

  it('an empty list or null clears both', () => {
    const t = task()
    writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'lasse', kind: 'question' }] })
    writes(eml).trackTask(t.id, { waits: [] })
    expect([props(t.id).waits, props(t.id).waiting_on]).toEqual([undefined, undefined])
    writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'lasse', kind: 'question' }] })
    writes(eml).trackTask(t.id, { waits: null })
    expect([props(t.id).waits, props(t.id).waiting_on]).toEqual([undefined, undefined])
  })

  it('a flat waiting_on write (a cockpit that knows one wait) replaces waits with that wait', () => {
    const t = task()
    writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'lasse', kind: 'question' }, { id: 'b', who: 'dominik', kind: 'go' }] })
    writes(eml).trackTask(t.id, { waiting_on: { who: 'lasse', kind: 'review', why: 'done', since: '2026-11-23T10:00:00.000Z', session_id: 's1' } })
    expect(props(t.id).waits).toEqual([{ id: 's1', who: 'lasse', kind: 'review', why: 'done', since: '2026-11-23T10:00:00.000Z', session_id: 's1' }])
    // values that do not fit a wait are left out of it; waiting_on keeps them as written
    writes(eml).trackTask(t.id, { waiting_on: { who: 'lasse', kind: 'someday', since: 'yesterday', note: 'x' } })
    expect(props(t.id).waits).toEqual([{ id: 'waiting_on', who: 'lasse' }])
    expect(props(t.id).waiting_on).toEqual({ who: 'lasse', kind: 'someday', since: 'yesterday', note: 'x' })
    // no who, no wait
    writes(eml).trackTask(t.id, { waiting_on: { why: 'nobody' } })
    expect(props(t.id).waits).toBeUndefined()
    writes(eml).trackTask(t.id, { waiting_on: null })
    expect([props(t.id).waits, props(t.id).waiting_on]).toEqual([undefined, undefined])
  })

  it('a task created with waiting_on gets its waits', () => {
    const t = writes(eml).store(validTask({ scope: 'project.eml', properties: { waiting_on: { who: 'lasse', kind: 'go', session_id: 's1' } } }))
    expect(props(t.id).waits).toEqual([{ id: 's1', who: 'lasse', kind: 'go', session_id: 's1' }])
  })

  it('refuses both shapes in one call, a repeated id, an unknown key and an entry without who', () => {
    const t = task()
    expect(() => writes(eml).trackTask(t.id, { waits: [], waiting_on: null })).toThrow('not both')
    expect(() => writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'x' }, { id: 'a', who: 'y' }] })).toThrow('waits: id a occurs twice.')
    expect(() => writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'x', owner: 'y' }] })).toThrow('waits[0] has unknown key owner')
    expect(() => writes(eml).trackTask(t.id, { waits: [{ id: 'a' }] })).toThrow('waits[0] needs who.')
    expect(() => writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'x', since: 3 }] })).toThrow('waits[0].since must be an ISO date')
  })
})

describe('the run object', () => {
  let eml: EML
  let taskId: string
  const juno = () => eml.env({ handle: 'juno', session_id: 's1', ingestion_method: 'direct' })
  const ada = () => eml.env({ handle: 'ada', session_id: 's2', ingestion_method: 'direct' })
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test', clock: () => '2026-11-23T12:00:00.000Z' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
    taskId = writes(eml).store(validTask({ scope: 'project.eml' })).id
  })
  afterEach(() => eml.close())

  const changes = () => eml.engrams.entries(taskId, ['change']).map(e => e.text)

  it('is created by its member, with defaults for state, started_at and last_activity_at, and journaled on its task', () => {
    const { object } = createObject(eml, 'run', { id: 'sess-1', task_id: taskId, member: 'juno', agent: 'atlas', origin: 'runner', driver: 'agent' }, juno())
    expect(object).toEqual({
      id: 'sess-1', task_id: taskId, member: 'juno', agent: 'atlas', origin: 'runner', driver: 'agent', state: 'running',
      started_at: '2026-11-23T12:00:00.000Z', last_activity_at: '2026-11-23T12:00:00.000Z', ended_at: null, end_reason: null, result: null,
      created_at: '2026-11-23T12:00:00.000Z', updated_at: '2026-11-23T12:00:00.000Z',
    })
    expect(changes()).toContain('run sess-1 started (runner, agent, atlas)')
    expect(readObject(eml, 'run', { id: 'sess-1' })).toEqual(object)
  })

  it('only its member changes it; the fixed fields never change; every write is its last activity', () => {
    createObject(eml, 'run', { id: 'sess-1', task_id: taskId, member: 'juno', origin: 'user', driver: 'human', started_at: '2026-11-23T11:00:00Z' }, juno())
    expect(() => updateObject(eml, 'run', 'sess-1', { state: 'idle' }, ada())).toThrow('only its member juno changes run sess-1.')
    expect(() => updateObject(eml, 'run', 'sess-1', { state: 'idle' })).toThrow('only its member juno changes run sess-1.')
    for (const k of ['task_id', 'member', 'origin', 'started_at', 'id']) {
      expect(() => updateObject(eml, 'run', 'sess-1', { [k]: k === 'started_at' ? '2026-11-23' : 'x' }, juno())).toThrow(`${k} cannot change.`)
    }
    const r = updateObject(eml, 'run', 'sess-1', { state: 'idle', result: 'Draft ready.' }, juno())!
    expect(r.diff).toEqual({ state: ['running', 'idle'], result: [null, 'Draft ready.'], last_activity_at: ['2026-11-23T11:00:00.000Z', '2026-11-23T12:00:00.000Z'] })
  })

  it('ending sets ended_at and its reason; a resume clears both; end fields only on an ended run', () => {
    createObject(eml, 'run', { id: 'sess-1', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())
    expect(() => updateObject(eml, 'run', 'sess-1', { end_reason: 'finished' }, juno())).toThrow('end_reason is for an ended run.')
    expect(() => updateObject(eml, 'run', 'sess-1', { state: 'ended', end_reason: 'bored' }, juno())).toThrow('end_reason must be one of finished, put_away, failed, crashed.')
    expect(() => updateObject(eml, 'run', 'sess-1', { last_activity_at: null }, juno())).toThrow('last_activity_at cannot be cleared.')
    updateObject(eml, 'run', 'sess-1', { state: 'ended', end_reason: 'put_away' }, juno())
    expect(eml.runs.get('sess-1')).toMatchObject({ state: 'ended', end_reason: 'put_away', ended_at: '2026-11-23T12:00:00.000Z' })
    updateObject(eml, 'run', 'sess-1', { state: 'running' }, juno())
    expect(eml.runs.get('sess-1')).toMatchObject({ state: 'running', end_reason: null, ended_at: null })
    const crashed = createObject(eml, 'run', { id: 'sess-2', task_id: taskId, member: 'juno', origin: 'runner', driver: 'agent', state: 'ended', end_reason: 'crashed' }, juno()).object
    expect(crashed).toMatchObject({ state: 'ended', end_reason: 'crashed', ended_at: '2026-11-23T12:00:00.000Z' })
    expect(() => createObject(eml, 'run', { id: 'sess-3', task_id: taskId, member: 'juno', origin: 'user', driver: 'human', state: 'awaiting_input' }, juno())).toThrow('state must be one of running, idle, ended.')
    expect(() => createObject(eml, 'run', { id: 'sess-3', task_id: taskId, member: 'juno', origin: 'user', driver: 'human', heartbeat_at: '2026-11-23' }, juno())).toThrow('heartbeat_at')
  })

  it('a member starts runs only for themself, on a task of this brain, once per session', () => {
    const note = writes(eml).store(validNote({ scope: 'project.eml' })).id
    expect(() => createObject(eml, 'run', { id: 's', task_id: taskId, member: 'ada', origin: 'user', driver: 'human' }, juno())).toThrow('member is the member who writes it (juno), not ada.')
    expect(() => createObject(eml, 'run', { id: 's', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' })).toThrow('this write has no handle')
    expect(() => createObject(eml, 'run', { id: 's', task_id: note, member: 'juno', origin: 'user', driver: 'human' }, juno())).toThrow('is not a task of this brain')
    expect(() => createObject(eml, 'run', { id: 'a b', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())).toThrow('a run id is letters')
    expect(() => createObject(eml, 'run', { id: 's', task_id: taskId, member: 'juno', origin: 'cron', driver: 'human' }, juno())).toThrow('origin must be one of user, runner, job.')
    expect(() => createObject(eml, 'run', { id: 's', task_id: taskId, member: 'juno', origin: 'user', driver: 'human', agent: 'Not A Handle' }, juno())).toThrow('agent is 1–63 characters')
    createObject(eml, 'run', { id: 's', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())
    expect(() => createObject(eml, 'run', { id: 's', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())).toThrow('already exists')
  })

  it('its end and a resume are journaled on the task; the states between are not', () => {
    createObject(eml, 'run', { id: 'sess-1', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())
    updateObject(eml, 'run', 'sess-1', { state: 'idle' }, juno())
    updateObject(eml, 'run', 'sess-1', { state: 'ended', end_reason: 'finished' }, juno())
    updateObject(eml, 'run', 'sess-1', { state: 'running' }, juno())
    expect(changes().filter(t => t.startsWith('run '))).toEqual(['run sess-1 started (user, human)', 'run sess-1 ended (finished)', 'run sess-1 resumed'])
  })

  it('lists the runs not ended by default, a state with the status filter', () => {
    createObject(eml, 'run', { id: 'a', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())
    createObject(eml, 'run', { id: 'b', task_id: taskId, member: 'ada', origin: 'job', driver: 'agent', state: 'ended' }, ada())
    expect((readObject(eml, 'run') as Array<{ id: string }>).map(r => r.id)).toEqual(['a'])
    expect((readObject(eml, 'run', { status: 'ended' }) as Array<{ id: string }>).map(r => r.id)).toEqual(['b'])
    expect(() => readObject(eml, 'run', { status: 'gone' })).toThrow('status for run is one of running, idle, ended.')
    expect(eml.runs.list({ task_id: 'other' })).toEqual([])
    // the newest run of each task, whatever its state
    createObject(eml, 'run', { id: 'c', task_id: taskId, member: 'juno', origin: 'user', driver: 'human', started_at: '2026-11-23T13:00:00Z', state: 'ended' }, juno())
    expect((readObject(eml, 'run', { latest: true }) as Array<{ id: string }>).map(r => r.id)).toEqual(['c'])
    // a number: the newest n runs of each task, newest first per task
    expect((readObject(eml, 'run', { latest: 2 }) as Array<{ id: string }>).map(r => r.id)).toEqual(['c', 'b'])
    expect(() => readObject(eml, 'run', { latest: 51 })).toThrow('whole number from 1 to 50')
    expect(() => readObject(eml, 'run', { latest: 0 })).toThrow('whole number from 1 to 50')
    expect(() => readObject(eml, 'run', { latest: Number.NaN })).toThrow('whole number from 1 to 50')
    expect(() => readObject(eml, 'project', { latest: true })).toThrow('for runs only')
  })
})

describe('the run member rule in a shared brain', () => {
  const BRAIN = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
  const DEVICE = 'a3sZzh-3scuWtpRhBZ11JKFldGAAN8sXviHJMKrc6U4'
  const T0 = Date.parse('2026-11-23T08:00:00.000Z')
  const NONE = { handle: null, agent: null, ingestion_method: null, session_id: null, model: null, harness: null }
  const as = (handle: string) => ({ ...NONE, handle, ingestion_method: 'mcp' })

  function op(n: number, call: string, args: unknown, provenance: Record<string, unknown>): OpEnvelope {
    return {
      op_id: uuidv5(BRAIN, `op ${n}`), schema: CURRENT_BRAIN_SCHEMA_VERSION, call, args: args as never, provenance: provenance as never,
      team: { brain: BRAIN, device: DEVICE, base_seq: n - 1, head_hash: '0'.repeat(64) },
    }
  }
  const take = (eml: EML, seq: number, o: OpEnvelope) =>
    eml.takeRelayed({ seq, at: new Date(T0 + seq * 1000).toISOString(), op_id: o.op_id, payload: plainJson(o), signature: null, rejected: null }, o).rejected

  it('every replica refuses one member\'s op on another member\'s run and keeps it as rejected', () => {
    const eml = EML.fromConnection(initDatabase(':memory:', undefined, BRAIN, { log: false }), 'test')
    expect(take(eml, 1, op(1, 'brain.genesis', { state_hash: eml.stateHash() }, NONE))).toBeNull()
    expect(take(eml, 2, op(2, 'object.create', { object: 'project', fields: { id: 'eml', name: 'EML' } }, as('lasse')))).toBeNull()
    expect(take(eml, 3, op(3, 'engram.create', validTask({ scope: 'project.eml', title: 'shared-task' }), as('lasse')))).toBeNull()
    const taskId = (eml as any).db.prepare(`SELECT id FROM engrams WHERE title = 'shared-task'`).get().id as string
    expect(take(eml, 4, op(4, 'object.create', { object: 'run', fields: { id: 'sess-l', task_id: taskId, member: 'lasse', origin: 'user', driver: 'human' } }, as('lasse')))).toBeNull()
    expect(take(eml, 5, op(5, 'object.update', { object: 'run', id: 'sess-l', patch: { state: 'ended' } }, as('dominik'))))
      .toBe('INVALID: Invalid object: only its member lasse changes run sess-l.')
    expect(take(eml, 6, op(6, 'object.create', { object: 'run', fields: { id: 'sess-d', task_id: taskId, member: 'lasse', origin: 'user', driver: 'human' } }, as('dominik'))))
      .toBe('INVALID: Invalid object: a run\'s member is the member who writes it (dominik), not lasse.')
    expect(eml.runs.get('sess-l')!.state).toBe('running')
    expect(eml.runs.get('sess-d')).toBeNull()
    expect(take(eml, 7, op(7, 'object.update', { object: 'run', id: 'sess-l', patch: { state: 'ended' } }, as('lasse')))).toBeNull()
    expect(eml.runs.get('sess-l')!.state).toBe('ended')
    eml.close()
  })
})
