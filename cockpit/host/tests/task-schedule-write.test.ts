import { describe, it, expect } from 'vitest'
import { editTaskSchedule, scheduleWrite, ScheduleWriteError, writeTaskSchedule, type ScheduledTask } from '../src/application/task-schedule-write.js'
import { addCron, clearWake, setWake } from '../src/domain/task-schedule.js'

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
