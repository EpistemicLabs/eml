import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextRunOfSchedule, sameSchedule, scheduleOfJob, scheduleOfJobs } from '../src/domain/task-schedule.js'
import { createScheduleMirror } from '../src/application/schedule-mirror.js'
import type { Job } from '../src/domain/job.js'

// paths.ts reads the home at import time — set it before loading the modules that use it.
const home = mkdtempSync(join(tmpdir(), 'cockpit-schedule-mirror-'))
process.env.EML_COCKPIT_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

const NOW = Date.parse('2026-11-24T10:00:00.000Z')

const job = (patch: Partial<Job> = {}): Job => ({
  id: 'j1', name: 'Daily check', kind: 'scheduled', spaceId: null, createdBy: null, createdAt: '', updatedAt: '', taskId: 't1', prompt: 'check',
  target: { type: 'worker', projectId: 'bp-eml' }, triggers: [{ type: 'schedule', cron: '0 8 * * *', timeZone: 'Asia/Makassar' }],
  toolProfile: null, reply: {}, end: null, notify: 'needs-me', paused: false, pausedReason: null, endedAt: null, nextRunAt: '2026-11-25T00:00:00.000Z',
  runCount: 0, failures: 0, ...patch,
} as Job)

describe('a task\'s schedule', () => {
  it('is a job\'s timing: a repeat rule or one time, its zone, paused when held, a new session for a worker, the last one resumed otherwise', () => {
    expect(scheduleOfJob(job())).toEqual({ cron: '0 8 * * *', time_zone: 'Asia/Makassar', session: 'new' })
    expect(scheduleOfJob(job({ triggers: [{ type: 'schedule', at: '2026-11-28T10:00', timeZone: 'Asia/Makassar' }], target: { type: 'session', sessionId: 's1' } })))
      .toEqual({ at: '2026-11-28T02:00:00.000Z', time_zone: 'Asia/Makassar', session: 'resume' })
    expect(scheduleOfJob(job({ paused: true }))).toMatchObject({ paused: true })
    expect(scheduleOfJob(job({ endedAt: '2026-11-24T09:00:00.000Z' }))).toBeNull()
    expect(scheduleOfJob(job({ triggers: [{ type: 'channel' } as never] }))).toBeNull()
  })

  it('of several jobs, the running one due first; the next run is computed, never stored', () => {
    const later = job({ id: 'j2', triggers: [{ type: 'schedule', cron: '0 9 * * 1', timeZone: 'UTC' }], nextRunAt: '2026-11-30T09:00:00.000Z' })
    expect(scheduleOfJobs([later, job()])).toMatchObject({ cron: '0 8 * * *' })
    expect(scheduleOfJobs([])).toBeNull()
    expect(nextRunOfSchedule({ cron: '0 8 * * *', time_zone: 'Asia/Makassar' }, NOW)).toBe('2026-11-25T00:00:00.000Z')
    expect(nextRunOfSchedule({ at: '2026-11-28T02:00:00.000Z' }, NOW)).toBe('2026-11-28T02:00:00.000Z')
    expect(nextRunOfSchedule({ at: '2026-11-20T02:00:00.000Z' }, NOW)).toBeNull()
    expect(nextRunOfSchedule({ cron: '0 8 * * *', paused: true }, NOW)).toBeNull()
    expect(sameSchedule({ at: '2026-11-28T02:00:00Z', session: 'new' }, { session: 'new', at: '2026-11-28T02:00:00.000Z' })).toBe(true)
  })
})

function brainOf(tasks: Record<string, { status: string; properties: Record<string, unknown> }>) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  let reads = 0
  return {
    posts,
    reads: () => reads,
    async get(path: string) {
      reads++
      const t = tasks[decodeURIComponent(path.slice('/engram/'.length))]
      if (!t) throw new Error('not found')
      return { id: path.slice('/engram/'.length), ...t }
    },
    async post(path: string, body: Record<string, unknown>) {
      posts.push({ path, body })
      const id = /^\/task\/([^/]+)\/track$/.exec(path)![1]
      tasks[id].properties.delegation = body.delegation
      return {}
    },
  }
}

describe('the schedule mirror', () => {
  const setup = (brain: ReturnType<typeof brainOf>, jobs: Job[]) => {
    const clock = { now: NOW }
    const mirror = createScheduleMirror({
      spaces: () => [{ id: 'main', name: 'Main', main: true } as never], brain: () => brain, jobs: () => jobs,
      agentOf: () => 'atlas', now: () => clock.now, log: () => {},
    })
    return { mirror, clock }
  }

  it('writes a job\'s timing into its task\'s delegation once, keeps the rest of it, and reads the brain again only when it changed', async () => {
    const brain = brainOf({ t1: { status: 'active', properties: { delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-24T09:00:00.000Z' } } } })
    const jobs = [job()]
    const { mirror } = setup(brain, jobs)
    await mirror.sync()
    expect(brain.posts).toEqual([{ path: '/task/t1/track', body: {
      delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-24T09:00:00.000Z', schedule: { cron: '0 8 * * *', time_zone: 'Asia/Makassar', session: 'new' } },
      text: 'Its schedule, as the job on the owner\'s cockpit runs it.',
    } }])
    const reads = brain.reads()
    await mirror.sync()
    expect(brain.reads()).toBe(reads)
    expect(brain.posts).toHaveLength(1)

    jobs[0] = job({ paused: true })
    await mirror.sync()
    expect(brain.posts.at(-1)!.body.delegation).toMatchObject({ schedule: { paused: true } })

    // the job ends: the task loses its schedule, the rest of the delegation stays
    jobs.length = 0
    await mirror.sync()
    expect(brain.posts.at(-1)!.body.delegation).toEqual({ agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-24T09:00:00.000Z' })
  })

  it('a job whose task is gone is looked at again only after a while, not at every sync', async () => {
    const brain = brainOf({})
    const { mirror } = setup(brain, [job({ taskId: 'gone' })])
    await mirror.sync()
    await mirror.sync()
    expect(brain.reads()).toBe(1)
  })

  it('a task without a delegation gets one for the space\'s agent, without a checkpoint or a request; a closed task is left alone', async () => {
    const brain = brainOf({ t1: { status: 'planned', properties: {} }, t2: { status: 'resolved', properties: {} } })
    const { mirror } = setup(brain, [job(), job({ id: 'j2', taskId: 't2' })])
    await mirror.sync()
    expect(brain.posts.map((p) => [p.path, p.body.delegation])).toEqual([
      ['/task/t1/track', { agent: 'atlas', schedule: { cron: '0 8 * * *', time_zone: 'Asia/Makassar', session: 'new' } }],
    ])
  })
})
