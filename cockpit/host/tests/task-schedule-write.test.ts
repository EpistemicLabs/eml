import { describe, it, expect } from 'vitest'
import { editTaskSchedule, ScheduleChangedError, scheduleWrite, scheduleWritesQueued, ScheduleWriteError, writeTaskSchedule, type ScheduledTask } from '../src/application/task-schedule-write.js'
import { addCron, clearWake, setPaused, setWake } from '../src/domain/task-schedule.js'

function brainWith(task: ScheduledTask) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const gets: string[] = []
  return {
    posts, gets,
    brain: {
      async get(path: string) { gets.push(path); return structuredClone(task) },
      async post(path: string, body: Record<string, unknown>) { posts.push({ path, body }); return {} },
    },
  }
}
const daily = { crons: ['0 8 * * *'], time_zone: 'UTC' }
const delegated = (schedule?: Record<string, unknown>): ScheduledTask => ({
  id: 't1', status: 'active', properties: { delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-20T00:00:00.000Z', ...(schedule ? { schedule } : {}) } },
})

describe('writing a task\'s schedule to the brain', () => {
  it('reads the task, applies the edit and posts the whole delegation with everything else unchanged', async () => {
    const w = brainWith(delegated(daily))
    const written = await editTaskSchedule(w.brain, 't1', (schedule) => setWake(schedule, { at: '2026-11-27T02:00:00Z', why: 'Look again', bySession: 's1' }))
    expect(w.gets).toEqual(['/engram/t1'])
    expect(w.posts).toEqual([{ path: '/task/t1/track', body: { delegation: {
      agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-20T00:00:00.000Z',
      schedule: { crons: ['0 8 * * *'], at: '2026-11-27T02:00:00.000Z', why: 'Look again', by_session: 's1', time_zone: 'UTC' },
    } } }])
    expect(written).toMatchObject({ changed: true, schedule: { crons: ['0 8 * * *'], at: '2026-11-27T02:00:00.000Z' }, task: { id: 't1' } })
  })

  it('an edit that leaves no schedule writes the delegation without one, which ends it in the brain', async () => {
    const w = brainWith(delegated({ at: '2026-11-27T02:00:00.000Z', by_session: 's1' }))
    const written = await editTaskSchedule(w.brain, 't1', (schedule) => clearWake(schedule, { onlyBySession: 's1' }))
    expect(w.posts).toEqual([{ path: '/task/t1/track', body: { delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-20T00:00:00.000Z' } } }])
    expect(written).toMatchObject({ changed: true, schedule: null })
  })

  it('an edit that changes nothing writes nothing', async () => {
    const w = brainWith(delegated({ at: '2026-11-27T02:00:00.000Z', by_session: 's1' }))
    const written = await editTaskSchedule(w.brain, 't1', (schedule) => clearWake(schedule, { onlyBySession: 's2' }))
    expect(w.posts).toEqual([])
    expect(written).toMatchObject({ changed: false, schedule: { at: '2026-11-27T02:00:00.000Z', by_session: 's1' } })
    await writeTaskSchedule(w.brain, 't1', { by_session: 's1', at: '2026-11-27T02:00:00Z' })
    expect(w.posts).toEqual([])
  })

  it('a journal line and further fields go in the same call, or on their own when the schedule stays', async () => {
    const w = brainWith(delegated(daily))
    await editTaskSchedule(w.brain, 't1', (schedule) => addCron(schedule, '0 18 * * *'), { text: 'An evening time was added.', fields: { content: 'New text', delegation: { agent: 'someone' } } })
    expect(w.posts[0].body).toEqual({ content: 'New text', delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-20T00:00:00.000Z', schedule: { crons: ['0 8 * * *', '0 18 * * *'], time_zone: 'UTC' } }, text: 'An evening time was added.' })
    await editTaskSchedule(w.brain, 't1', (schedule) => schedule, { text: 'Looked at.' })
    expect(w.posts[1].body).toEqual({ text: 'Looked at.' })
  })

  it('a task without a delegation gets one for the given agent with its schedule; without an agent the write is refused', async () => {
    const plain: ScheduledTask = { id: 't1', status: 'active', properties: {} }
    const w = brainWith(plain)
    await writeTaskSchedule(w.brain, 't1', daily, { agent: 'atlas' })
    expect(w.posts).toEqual([{ path: '/task/t1/track', body: { delegation: { agent: 'atlas', schedule: daily } } }])
    await expect(writeTaskSchedule(w.brain, 't1', daily)).rejects.toThrow(ScheduleWriteError)
    // nothing to end on a task without a delegation
    await writeTaskSchedule(w.brain, 't1', null)
    expect(w.posts).toHaveLength(1)
  })

  it('a delegation written only flat (before schema 23) is carried as agent and checkpoint', () => {
    expect(scheduleWrite({ id: 't1', status: 'active', properties: { delegate: 'atlas', checkpoint: 'none' } }, daily)).toEqual({ delegation: { agent: 'atlas', checkpoint: 'none', schedule: daily } })
    expect(scheduleWrite(delegated(daily), daily)).toBeNull()
  })

  it('the edit sees the task, and an edit that throws writes nothing', async () => {
    const w = brainWith(delegated(daily))
    await expect(editTaskSchedule(w.brain, 't1', (schedule, task) => addCron(schedule, task.status === 'active' ? 'not a cron' : '0 9 * * *'))).rejects.toThrow('cron:')
    expect(w.posts).toEqual([])
  })
})

// A brain whose reads and writes take a moment, as the real one does: a write lands some ticks after the read.
function slowBrain(task: ScheduledTask & { rev?: number }, opts: { conflicts?: number } = {}) {
  const state = structuredClone(task)
  const posts: Array<Record<string, unknown>> = []
  let conflicts = opts.conflicts ?? 0
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1))
  return {
    state, posts,
    brain: {
      async get() { await tick(); return structuredClone(state) },
      async post(_path: string, body: Record<string, unknown>) {
        await tick()
        posts.push(body)
        if (conflicts > 0) {
          conflicts -= 1
          // someone else wrote the task in between
          state.rev = (state.rev ?? 0) + 1
          state.properties = { ...state.properties, delegation: { ...state.properties!.delegation!, checkpoint: 'before' } }
          throw Object.assign(new Error('the engram changed since it was read'), { status: 409 })
        }
        if (typeof body.base_rev === 'number' && body.base_rev !== state.rev) throw Object.assign(new Error('the engram changed since it was read'), { status: 409 })
        if (body.delegation) state.properties = { ...state.properties, delegation: body.delegation as never }
        if (typeof state.rev === 'number') state.rev += 1
        return {}
      },
    },
  }
}

describe('schedule writes of one task never overlap', () => {
  it('two edits made at the same moment both land: the second reads what the first wrote', async () => {
    const w = slowBrain(delegated(daily))
    // the engine sets the wake-up while the owner pauses the schedule
    const [woken, paused] = await Promise.all([
      editTaskSchedule(w.brain, 't1', (schedule) => setWake(schedule, { at: '2026-11-27T02:00:00Z', why: 'Look again' })),
      editTaskSchedule(w.brain, 't1', (schedule) => setPaused(schedule, true), { text: 'The owner paused its schedule.' }),
    ])
    expect(w.state.properties?.delegation?.schedule).toEqual({ crons: ['0 8 * * *'], at: '2026-11-27T02:00:00.000Z', why: 'Look again', time_zone: 'UTC', paused: true })
    expect(woken.schedule).not.toHaveProperty('paused')
    expect(paused.schedule).toMatchObject({ at: '2026-11-27T02:00:00.000Z', paused: true })
    // in the order they were asked for, one after the other
    expect(w.posts.map((body) => Object.keys((body.delegation as { schedule: object }).schedule).includes('paused'))).toEqual([false, true])
  })

  it('writes to different tasks do not wait for each other, and a write that fails holds nothing up', async () => {
    const a = slowBrain(delegated(daily))
    const order: string[] = []
    const slow = editTaskSchedule({ ...a.brain, get: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); order.push('t1 read'); return structuredClone(a.state) } }, 't1', (s) => setPaused(s, true))
    const other = editTaskSchedule(a.brain, 't2', (s) => setPaused(s, true)).then(() => order.push('t2 written'))
    await Promise.all([slow, other])
    expect(order).toEqual(['t2 written', 't1 read'])

    const failing = editTaskSchedule({ ...a.brain, get: async () => { throw new Error('the brain does not answer') } }, 't1', (s) => s)
    const after = editTaskSchedule(a.brain, 't1', (s) => setPaused(s, false))
    await expect(failing).rejects.toThrow('the brain does not answer')
    expect((await after).schedule).not.toHaveProperty('paused')
    // nothing is kept for a task once its writes are through
    await Promise.resolve()
    expect(scheduleWritesQueued()).toBe(0)
  })

  it('carries the rev the task was read at, and reads again once when the task changed in between', async () => {
    const w = slowBrain({ ...delegated(daily), rev: 7 }, { conflicts: 1 })
    const written = await editTaskSchedule(w.brain, 't1', (schedule) => setPaused(schedule, true))
    expect(w.posts.map((body) => body.base_rev)).toEqual([7, 8])
    // the second try wrote onto what the other writer had left
    expect(w.posts[1].delegation).toMatchObject({ checkpoint: 'before', schedule: { paused: true } })
    expect(written).toMatchObject({ changed: true, schedule: { paused: true } })
    // a task that keeps changing: the second conflict is the caller's to see
    const busy = slowBrain({ ...delegated(daily), rev: 7 }, { conflicts: 2 })
    await expect(editTaskSchedule(busy.brain, 't1', (schedule) => setPaused(schedule, true))).rejects.toMatchObject({ status: 409 })
    expect(busy.posts).toHaveLength(2)
    // a brain that gives no rev gets none back
    const plain = slowBrain(delegated(daily))
    await editTaskSchedule(plain.brain, 't1', (schedule) => setPaused(schedule, true))
    expect(plain.posts[0]).not.toHaveProperty('base_rev')
  })

  it('onlyWithChange: an edit that leaves the schedule as it is writes nothing at all, not even its journal line', async () => {
    const w = brainWith(delegated(daily))
    const kept = await editTaskSchedule(w.brain, 't1', (schedule) => schedule, { text: 'Its schedule was removed.', fields: { content: 'New text' }, onlyWithChange: true })
    expect(kept).toMatchObject({ changed: false, schedule: daily })
    expect(w.posts).toEqual([])
    await editTaskSchedule(w.brain, 't1', () => null, { text: 'Its schedule was removed.', onlyWithChange: true })
    expect(w.posts).toEqual([{ path: '/task/t1/track', body: { delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-20T00:00:00.000Z' }, text: 'Its schedule was removed.' } }])
  })

  it('baseRev: the write is made only on the task as it was read by the caller; a task that changed since is not written, and not read again for another try', async () => {
    const same = slowBrain({ ...delegated(daily), rev: 7 })
    await editTaskSchedule(same.brain, 't1', (schedule) => setPaused(schedule, true), { baseRev: 7 })
    expect(same.posts.map((body) => body.base_rev)).toEqual([7])
    // changed before the write's own read
    const moved = slowBrain({ ...delegated(daily), rev: 8 })
    await expect(editTaskSchedule(moved.brain, 't1', (schedule) => setPaused(schedule, true), { baseRev: 7 })).rejects.toThrow(ScheduleChangedError)
    expect(moved.posts).toEqual([])
    // changed between that read and the write: the brain refuses it, and no second try is made
    const late = slowBrain({ ...delegated(daily), rev: 7 }, { conflicts: 1 })
    await expect(editTaskSchedule(late.brain, 't1', (schedule) => setPaused(schedule, true), { baseRev: 7 })).rejects.toThrow(ScheduleChangedError)
    expect(late.posts).toHaveLength(1)
  })
})
