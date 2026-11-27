import { describe, it, expect } from 'vitest'
import { createTurnWake, NO_TASK, scheduleAfterTurn, TASK_CLOSED, turnWakeNote } from '../src/application/turn-wake.js'
import type { ScheduledTask } from '../src/application/task-schedule-write.js'
import type { ScheduleFields } from '../src/domain/delegation.js'
import { newRecord } from '../src/domain/job.js'
import { formatInZone } from '../src/domain/schedule.js'
import type { ToolProfile } from '../src/domain/tool-profile.js'
import { deriveTurn, type WakeEdit } from '../src/domain/turn-end.js'
import { JobStore } from '../src/job-store.js'

const NOW = Date.parse('2026-11-25T08:00:00Z')
const ZONE = 'Asia/Bangkok' // UTC+7
const WEEKDAYS: ScheduleFields = { crons: ['0 8 * * 1-5'], time_zone: 'Asia/Makassar' }
const WHY = 'See whether Acme answered'
const local = (at: string) => `${formatInZone(Date.parse(at), ZONE)} (${ZONE})`

/** A brain that keeps one task and applies each track call's schedule to it, as the real one does (brain schema 25). */
function world(opts: { schedule?: ScheduleFields | null; status?: string; taskId?: string | null; known?: boolean; noBrain?: boolean; failing?: boolean; delegation?: boolean; moving?: boolean; profile?: ToolProfile | null; record?: ToolProfile | null; held?: boolean; waits?: unknown[] } = {}) {
  const task: ScheduledTask = {
    id: 't1', status: opts.status ?? 'active',
    properties: {
      ...(opts.delegation === false ? {} : { delegation: { agent: 'atlas', checkpoint: 'after' } }),
      ...(opts.schedule ? { schedule: opts.schedule } : {}),
      ...(opts.waits ? { waits: opts.waits } : {}),
    },
  }
  const posts: Array<Record<string, unknown>> = []
  const log: string[] = []
  /** What was written, in order: the task's schedule (brain) and the task's record (store). */
  const writes: string[] = []
  let changed = 0
  const store = new JobStore(null)
  if (opts.record !== undefined) store.put({ ...newRecord({ id: 't1', spaceId: null }, '2026-11-01T00:00:00.000Z', 'maker'), toolProfile: opts.record })
  const records = { get: (id: string) => store.get(id), put: (record: Parameters<JobStore['put']>[0]) => { writes.push('record'); store.put(record) } }
  const brain = {
    async get() { if (opts.failing) throw new Error('the brain does not answer'); return structuredClone(task) },
    async post(_path: string, body: Record<string, unknown>) {
      posts.push(body)
      writes.push('schedule')
      if ('schedule' in body) {
        const { schedule: _old, ...rest } = task.properties ?? {}
        task.properties = body.schedule ? { ...rest, schedule: body.schedule as ScheduleFields } : rest
      }
      return {}
    },
  }
  const wake = createTurnWake({
    where: () => (opts.known === false ? null : { taskId: opts.taskId === undefined ? 't1' : opts.taskId, brain: opts.noBrain ? null : brain, agent: 'atlas', spaceId: null, toolProfile: opts.profile ?? null }),
    records,
    moving: () => opts.moving === true,
    // The task's record waits for the user's OK (its pendingApproval), as domain/job.ts scheduleFactsOf says it.
    scheduleFacts: () => (opts.held ? { needsOk: true } : {}),
    zone: () => ZONE, now: () => NOW, log: (line) => log.push(line), changed: () => { changed += 1 },
  })
  const schedule = () => task.properties?.schedule ?? null
  const delegation = () => task.properties?.delegation ?? null
  return { wake, posts, log, schedule, delegation, changed: () => changed, store, writes }
}

const set = (when: string, why = WHY, by?: string) => ({ edit: { kind: 'set' as const, when, why }, ...(by ? { by } : {}) })
const keep = { edit: { kind: 'keep' as const } }
const remove = { edit: { kind: 'remove' as const } }

describe('the task\'s schedule after a turn\'s end', () => {
  const by = { sessionId: 's1', agent: 'atlas', at: '2026-11-26T03:00:00.000Z', zone: ZONE }

  it('a check sets the wake-up with its reason, the agent it is for and the session, replaces the one before and never touches a repeating time', () => {
    const first = scheduleAfterTurn(WEEKDAYS, { kind: 'set', when: '2026-11-26T10:00', why: WHY }, by)
    expect(first).toEqual({ crons: ['0 8 * * 1-5'], at: '2026-11-26T03:00:00.000Z', why: WHY, by: 'atlas', by_session: 's1', time_zone: 'Asia/Makassar' })
    const second = scheduleAfterTurn(first, { kind: 'set', when: '2026-11-27T10:00', why: 'Other.' }, { ...by, sessionId: 's2', agent: 'nova', at: '2026-11-27T03:00:00.000Z' })
    expect(second).toEqual({ crons: ['0 8 * * 1-5'], at: '2026-11-27T03:00:00.000Z', why: 'Other.', by: 'nova', by_session: 's2', time_zone: 'Asia/Makassar' })
    // A task without a schedule gets one that holds only the wake-up, read in the user's zone.
    expect(scheduleAfterTurn(null, { kind: 'set', when: '2026-11-26T10:00', why: WHY }, by))
      .toEqual({ at: '2026-11-26T03:00:00.000Z', why: WHY, by: 'atlas', by_session: 's1', time_zone: ZONE })
  })

  it('check "none" removes the wake-up whoever set it and keeps the repeating times; a call without a check keeps everything', () => {
    const theirs: ScheduleFields = { ...WEEKDAYS, at: '2026-11-26T03:00:00.000Z', why: WHY, by: 'atlas', by_session: 'another' }
    expect(scheduleAfterTurn(theirs, { kind: 'remove' }, by)).toEqual(WEEKDAYS)
    expect(scheduleAfterTurn(theirs, { kind: 'keep' }, by)).toBe(theirs)
    expect(scheduleAfterTurn(null, { kind: 'keep' }, by)).toBeNull()
    // Nothing is left of a schedule that held only the wake-up.
    expect(scheduleAfterTurn({ at: '2026-11-26T03:00:00.000Z', by_session: 's1' }, { kind: 'remove' }, by)).toBeNull()
  })

  it('writes a journal line for a wake-up set, replaced, given a new reason or removed, and none for nothing changed', () => {
    const at = '2026-11-26T03:00:00.000Z'
    const later = '2026-11-27T03:00:00.000Z'
    expect(turnWakeNote(null, { at, why: WHY }, 'atlas', ZONE)).toBe(`Turn end: atlas set the wake-up for ${local(at)}: ${WHY}.`)
    expect(turnWakeNote({ at }, { at: later, why: WHY }, 'atlas', ZONE)).toBe(`Turn end: atlas set the wake-up for ${local(later)}: ${WHY} (it replaces ${local(at)}).`)
    expect(turnWakeNote({ at, why: 'Old.' }, { at, why: WHY }, 'atlas', ZONE)).toBe(`Turn end: atlas kept the wake-up at ${local(at)} with a new reason: ${WHY}.`)
    expect(turnWakeNote({ at }, null, 'atlas', ZONE)).toBe(`Turn end: atlas removed the wake-up (it was for ${local(at)}).`)
    expect(turnWakeNote({ at }, null, null, ZONE)).toBe(`Turn end: The agent removed the wake-up (it was for ${local(at)}).`)
    expect(turnWakeNote({ at, why: WHY }, { at, why: WHY }, 'atlas', ZONE)).toBeNull()
    expect(turnWakeNote(null, null, 'atlas', ZONE)).toBeNull()
  })
})

describe('a turn\'s end and the wake-up of the session\'s task', () => {
  it('a check writes the wake-up next to the repeating time, for the agent and the session, read in the user\'s zone, and answers with the instant saved', async () => {
    const w = world({ schedule: WEEKDAYS })
    const settled = await w.wake.settle('s1', set('2026-11-26T10:00', WHY, 'atlas'))
    const after = { crons: ['0 8 * * 1-5'], at: '2026-11-26T03:00:00.000Z', why: WHY, by: 'atlas', by_session: 's1', time_zone: 'Asia/Makassar' }
    expect(settled).toEqual({
      problem: null, saved: { at: Date.parse('2026-11-26T03:00:00Z'), zone: ZONE }, nextRun: true,
      outcome: 'set', before: WEEKDAYS, after, zone: ZONE, task: { status: 'active', waits: [] },
    })
    expect(w.schedule()).toEqual(after)
    // One write of the schedule with its journal line; the delegation is not touched.
    expect(w.posts).toEqual([{ schedule: after, text: `Turn end: atlas set the wake-up for ${local(after.at)}: ${WHY}.` }])
    expect(w.delegation()).toEqual({ agent: 'atlas', checkpoint: 'after' })
    expect(w.changed()).toBe(1)
    expect(w.log).toEqual(['[wake] s1 task t1: wake-up set for 2026-11-26T10:00 (Asia/Bangkok) = 2026-11-26T03:00:00.000Z'])
  })

  it('the wake-up is for the agent the host names, else the space\'s agent', async () => {
    const named = world()
    await named.wake.settle('s1', set('2026-11-26T10:00', WHY, 'nova'))
    expect(named.schedule()).toMatchObject({ by: 'nova', by_session: 's1' })
    const bare = world()
    await bare.wake.settle('s1', set('2026-11-26T10:00'))
    expect(bare.schedule()).toMatchObject({ by: 'atlas', by_session: 's1' })
  })

  it('another time replaces the wake-up: the task never holds two', async () => {
    const w = world({ schedule: WEEKDAYS })
    await w.wake.settle('s1', set('2026-11-26T10:00'))
    const settled = await w.wake.settle('s1', set('2026-11-27T15:30'))
    expect(settled.saved).toEqual({ at: Date.parse('2026-11-27T08:30:00Z'), zone: ZONE })
    expect(w.schedule()).toMatchObject({ crons: ['0 8 * * 1-5'], at: '2026-11-27T08:30:00.000Z', by_session: 's1' })
    expect(w.posts[1].text).toBe(`Turn end: atlas set the wake-up for ${local('2026-11-27T08:30:00.000Z')}: ${WHY} (it replaces ${local('2026-11-26T03:00:00.000Z')}).`)
  })

  it('a call without a check keeps the wake-up whoever set it, and writes nothing', async () => {
    const theirs: ScheduleFields = { ...WEEKDAYS, at: '2026-11-26T03:00:00.000Z', why: WHY, by: 'atlas', by_session: 'another' }
    const w = world({ schedule: theirs })
    expect(await w.wake.settle('s1', keep)).toEqual({
      problem: null, saved: null, nextRun: true, outcome: 'kept', before: theirs, after: theirs, zone: ZONE, task: { status: 'active', waits: [] },
    })
    expect(w.schedule()).toEqual(theirs)
    expect(w.posts).toEqual([])
    expect(w.changed()).toBe(0)
    expect(w.log).toEqual([])
    // A task without a wake-up: there is none, and was none.
    const none = world({ schedule: WEEKDAYS })
    expect(await none.wake.settle('s1', keep)).toMatchObject({ outcome: 'none', nextRun: true })
    expect(none.posts).toEqual([])
    expect((await world().wake.settle('s1', keep))).toMatchObject({ outcome: 'none', nextRun: false })
  })

  it('check "none" removes the wake-up whoever set it, keeps the repeating time, and says so in the journal', async () => {
    const w = world({ schedule: { ...WEEKDAYS, at: '2026-11-26T03:00:00.000Z', why: WHY, by: 'atlas', by_session: 'another' } })
    expect(await w.wake.settle('s1', remove)).toMatchObject({ problem: null, saved: null, nextRun: true, outcome: 'removed', after: WEEKDAYS })
    expect(w.schedule()).toEqual(WEEKDAYS)
    expect(w.posts).toEqual([{ schedule: WEEKDAYS, text: `Turn end: atlas removed the wake-up (it was for ${local('2026-11-26T03:00:00.000Z')}).` }])
    expect(w.log).toEqual(['[wake] s1 task t1: wake-up removed'])
    // Nothing to remove: nothing is written.
    const none = world({ schedule: WEEKDAYS })
    expect(await none.wake.settle('s1', remove)).toMatchObject({ outcome: 'none' })
    expect(none.posts).toEqual([])
  })

  it('an ask never clears the wake-up: one the schedule tool set for the agent survives an ask for the owner to do a step', async () => {
    // The wake-up as the schedule tool writes it: for atlas, set by no end_turn of this session.
    const scheduled: ScheduleFields = { at: '2026-11-26T03:00:00.000Z', why: 'Check whether the NRW form came back.', by: 'atlas', time_zone: ZONE }
    const w = world({ schedule: scheduled })
    const ctx = { owner: 'lasse', agent: 'atlas', members: ['lasse', 'atlas'] }
    const derived = deriveTurn({ result: 'The form is ready to sign.', ask: { who: 'lasse', what: 'sign and send the form', kind: 'do' } }, ctx)
    expect(derived).toMatchObject({ status: 'review', wait: { who: 'lasse', kind: 'do' }, wake: { kind: 'keep' } })
    const settled = await w.wake.settle('s1', { edit: derived.wake, by: 'atlas' })
    expect(settled).toMatchObject({ outcome: 'kept', nextRun: true, after: scheduled })
    expect(w.schedule()).toEqual(scheduled)
    expect(w.posts).toEqual([])
  })

  it('says whether the task has a next run once the call is applied', async () => {
    const run = async (schedule: ScheduleFields | null, edit: { edit: WakeEdit } = keep) => (await world({ schedule }).wake.settle('s1', edit)).nextRun
    expect(await run(null)).toBe(false)
    expect(await run(WEEKDAYS)).toBe(true)
    expect(await run({ ...WEEKDAYS, paused: true })).toBe(false)
    expect(await run({ ...WEEKDAYS, ends_at: '2026-11-25T07:00:00.000Z' })).toBe(false)
    // A wake-up that has passed is not ahead.
    expect(await run({ at: '2026-11-25T07:00:00.000Z' })).toBe(false)
    expect(await run({ at: '2026-11-25T09:00:00.000Z' })).toBe(true)
    // A wake-up the call kept counts, also one this session set; one it removed does not.
    expect(await run({ at: '2026-11-25T09:00:00.000Z', by_session: 's1' })).toBe(true)
    expect(await run({ at: '2026-11-25T09:00:00.000Z', by_session: 's1' }, remove)).toBe(false)
  })

  it('counts no repeating time held for the user\'s OK as a next run; the wake-up still counts', async () => {
    const held = async (schedule: ScheduleFields | null, edit: { edit: WakeEdit } = keep) => (await world({ schedule, held: true }).wake.settle('s1', edit)).nextRun
    // A record waiting for the OK holds the repeating times: the task has no next run, end_turn asks for a check.
    expect(await held(WEEKDAYS)).toBe(false)
    expect(await held({ ...WEEKDAYS, at: '2026-11-25T09:00:00.000Z' })).toBe(true)
    expect(await held({ ...WEEKDAYS, at: '2026-11-25T09:00:00.000Z' }, remove)).toBe(false)
    // A time the call sets is a wake-up, which fires while held.
    expect(await held(WEEKDAYS, set('2026-11-26T10:00'))).toBe(true)
  })

  it('answers with the task\'s status and waits as read', async () => {
    const waits = [{ id: 'w1', who: 'lasse', kind: 'do', why: 'sign it', session_id: 's0' }]
    const settled = await world({ waits }).wake.settle('s1', keep)
    expect(settled.task).toEqual({ status: 'active', waits: [expect.objectContaining({ id: 'w1', who: 'lasse', kind: 'do', why: 'sign it' })] })
  })

  it('sets a wake-up on a task without a delegation without giving it one: scheduling hands nothing to an agent', async () => {
    const w = world({ delegation: false })
    await w.wake.settle('s1', set('2026-11-26T10:00'))
    expect(w.posts).toEqual([{ schedule: { at: '2026-11-26T03:00:00.000Z', why: WHY, by: 'atlas', by_session: 's1', time_zone: ZONE }, text: expect.stringMatching(/^Turn end: atlas set the wake-up/) }])
    expect(w.delegation()).toBeNull()
  })

  it('refuses the check of a session without a task, with the reason and nothing to try again', async () => {
    const w = world({ taskId: null })
    expect(await w.wake.settle('s1', set('2026-11-26T10:00'))).toEqual({ problem: NO_TASK, fix: 'none', saved: null, nextRun: false })
    expect(NO_TASK).toBe('this session works on no task, and a wake-up is set on a task')
    // Without a check there is nothing to refuse, and nothing to say.
    expect(await w.wake.settle('s1', keep)).toEqual({ problem: null, saved: null, nextRun: false })
    expect(await w.wake.settle('s1', remove)).toEqual({ problem: null, saved: null, nextRun: false })
    expect(w.posts).toEqual([])
    expect(w.log).toEqual(['[wake] s1 wake-up not set: this session works on no task, and a wake-up is set on a task'])
    expect((await world({ known: false }).wake.settle('s1', set('2026-11-26T10:00'))).problem).toBe('the cockpit does not know this session')
  })

  it('sets no wake-up on a closed task, and leaves its schedule alone', async () => {
    const w = world({ status: 'resolved', schedule: { at: '2026-11-26T03:00:00.000Z', by_session: 's1' } })
    expect(await w.wake.settle('s1', set('2026-11-27T10:00'))).toEqual({ problem: TASK_CLOSED, fix: 'none', saved: null, nextRun: false })
    // A remove or a keep on a closed task writes nothing and has no next run.
    expect(await w.wake.settle('s1', remove)).toMatchObject({ problem: null, saved: null, nextRun: false })
    expect(await w.wake.settle('s1', keep)).toMatchObject({ problem: null, saved: null, nextRun: false })
    expect(w.posts).toEqual([])
  })

  it('refuses a time more than a year ahead and one that is no time, asking for another', async () => {
    const w = world()
    expect(await w.wake.settle('s1', set('2028-01-01T10:00'))).toMatchObject({ problem: 'at most a year ahead', fix: 'time', saved: null })
    expect(await w.wake.settle('s1', set('soon'))).toMatchObject({ problem: '"soon" is not a time', fix: 'time' })
    expect(w.posts).toEqual([])
  })

  it('writes nothing to a task whose jobs from before are still moving onto it: the call is to be made again', async () => {
    const w = world({ schedule: WEEKDAYS, moving: true })
    expect(await w.wake.settle('s1', set('2026-11-26T10:00')))
      .toEqual({ problem: 'the task\'s jobs from before are still moving onto it; in a minute it can be set', fix: 'again', saved: null, nextRun: false })
    expect(await w.wake.settle('s1', remove)).toEqual({ problem: 'the task\'s jobs from before are still moving onto it; in a minute it can be set', fix: 'again', saved: null, nextRun: false })
    // A keep writes nothing, so it is read as usual.
    expect(await w.wake.settle('s1', keep)).toMatchObject({ problem: null, outcome: 'none', nextRun: true })
    expect(w.posts).toEqual([])
  })

  it('reports a write that failed, as a call to make again; a failed keep is only logged', async () => {
    const w = world({ failing: true })
    expect(await w.wake.settle('s1', set('2026-11-26T10:00')))
      .toEqual({ problem: 'the task\'s schedule could not be written (the brain does not answer)', fix: 'again', saved: null, nextRun: false })
    expect(await w.wake.settle('s1', remove))
      .toEqual({ problem: 'the task\'s schedule could not be written (the brain does not answer)', fix: 'again', saved: null, nextRun: false })
    expect(await w.wake.settle('s1', keep)).toEqual({ problem: null, saved: null, nextRun: false })
    expect(w.log).toEqual(['[wake] s1 wake-up not set: the brain does not answer', '[wake] s1 wake-up not removed: the brain does not answer', '[wake] s1 wake-up not read: the brain does not answer'])
    expect((await world({ noBrain: true }).wake.settle('s1', set('2026-11-26T10:00'))).fix).toBe('again')
  })
})

describe('a wake-up set by a session with narrowed tools', () => {
  const NO_SHELL: ToolProfile = { deniedTools: ['Bash'], mcpServers: ['eml'] }

  it('a session with all its tools sets the wake-up: the task gets a record here with nothing limited, and one that exists is not touched', async () => {
    // ending a turn with a check is an explicit act on this machine: the record is what makes this cockpit fire a task no member owns
    const none = world()
    await none.wake.settle('s1', set('2026-11-26T10:00'))
    expect(none.writes).toEqual(['schedule', 'record'])
    expect(none.store.get('t1')).toMatchObject({ id: 't1', taskId: 't1', spaceId: null, createdBy: 's1', toolProfile: null, cursor: null, triggers: [] })
    expect(none.store.get('t1')).not.toHaveProperty('limited')
    // removing or keeping a wake-up makes no record
    for (const edit of [remove, keep]) {
      const other = world({ schedule: { at: '2026-11-26T03:00:00.000Z', by_session: 's1' } })
      await other.wake.settle('s1', edit)
      expect(other.store.get('t1')).toBeUndefined()
    }
    const has = world({ record: NO_SHELL })
    await has.wake.settle('s1', set('2026-11-26T10:00'))
    expect(has.store.get('t1')?.toolProfile).toEqual(NO_SHELL)
    expect(has.writes).toEqual(['schedule'])
  })

  it('on a task without a record: the schedule is written first, then a record with the session\'s profile', async () => {
    const w = world({ profile: NO_SHELL })
    expect((await w.wake.settle('s1', set('2026-11-26T10:00'))).problem).toBeNull()
    expect(w.writes).toEqual(['schedule', 'record'])
    expect(w.store.get('t1')).toMatchObject({ id: 't1', createdBy: 's1', toolProfile: NO_SHELL })
    expect(w.log.at(-2)).toBe('[wake] s1 task t1: its sessions get at most this session\'s tools')
  })

  it('narrows a wider record to what both allow, and leaves a narrower one as it is', async () => {
    const wider = world({ profile: NO_SHELL, record: { deniedTools: ['WebFetch'], mcpServers: null } })
    await wider.wake.settle('s1', set('2026-11-26T10:00'))
    expect(wider.store.get('t1')?.toolProfile).toEqual({ deniedTools: ['WebFetch', 'Bash'], mcpServers: ['eml'] })
    const narrower = world({ profile: NO_SHELL, record: { deniedTools: ['Bash', 'SendMessage'], mcpServers: ['eml'] } })
    await narrower.wake.settle('s1', set('2026-11-26T10:00'))
    expect(narrower.store.get('t1')?.toolProfile).toEqual({ deniedTools: ['Bash', 'SendMessage'], mcpServers: ['eml'] })
    expect(narrower.writes).toEqual(['schedule'])
  })

  it('touches no record when no wake-up was set: a call without a check, a closed task, a time that is refused', async () => {
    const kept = world({ profile: NO_SHELL, schedule: { at: '2026-11-26T03:00:00.000Z', why: WHY, by_session: 's1' } })
    await kept.wake.settle('s1', keep)
    expect(kept.store.get('t1')).toBeUndefined()
    const closed = world({ profile: NO_SHELL, status: 'resolved' })
    expect((await closed.wake.settle('s1', set('2026-11-26T10:00'))).problem).toBe(TASK_CLOSED)
    expect(closed.store.get('t1')).toBeUndefined()
    const bad = world({ profile: NO_SHELL })
    expect((await bad.wake.settle('s1', set('whenever'))).problem).toBe('"whenever" is not a time')
    expect(bad.store.get('t1')).toBeUndefined()
  })
})
