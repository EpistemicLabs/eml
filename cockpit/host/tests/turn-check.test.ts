import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Jobs, type JobCaller } from '../src/application/jobs.js'
import { checkName, createTurnCheck } from '../src/application/turn-check.js'
import { scheduleOfJob } from '../src/domain/task-schedule.js'
import { JobStore } from '../src/job-store.js'

const NOW = Date.parse('2026-11-25T08:00:00Z')

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), 'cockpit-turn-check-')), 'jobs.json')
  const store = new JobStore(file)
  const jobs = new Jobs({
    store, runner: { runNow: () => null, tick: async () => {} }, now: () => NOW,
    resolveProject: async () => 'bp-eml', findSession: () => null, addressOf: (id) => `eml-${id}`,
    providerKnown: () => true, defaultTimeZone: () => 'UTC',
  })
  const callers: Record<string, JobCaller> = {
    s1: { sessionId: 's1', spaceId: null, projectId: 'bp-eml', toolProfile: null, taskId: 't1' },
    s2: { sessionId: 's2', spaceId: null, projectId: 'bp-eml', toolProfile: null, taskId: 't1' },
  }
  const logs: string[] = []
  const check = createTurnCheck({ jobs, store, callerOf: (id) => callers[id] ?? null, log: (l) => logs.push(l) })
  const wanted = (at: string | null) => ({ at, taskName: 'Refund from Acme', prompt: 'The check is due.' })
  return { file, store, jobs, callers, check, wanted, logs }
}

describe('the check an end_turn call sets', () => {
  it('makes one one-time job on the session\'s task that wakes this session, marked as end_turn\'s', async () => {
    const { store, check, wanted, file } = setup()
    expect(await check.settle('s1', wanted('2026-11-27T10:00'))).toBeNull()
    const [job] = store.list()
    expect(store.list()).toHaveLength(1)
    expect(job).toMatchObject({
      name: 'Check: Refund from Acme', prompt: 'The check is due.', origin: 'end_turn', createdBy: 's1', taskId: 't1',
      target: { type: 'session', sessionId: 's1' }, triggers: [{ type: 'schedule', at: '2026-11-27T10:00:00.000Z', timeZone: 'UTC' }],
      nextRunAt: '2026-11-27T10:00:00.000Z',
    })
    // What the schedule mirror writes into the task: one time, resuming the session.
    expect(scheduleOfJob(job)).toMatchObject({ at: '2026-11-27T10:00:00.000Z', session: 'resume' })
    // The mark is kept with the job.
    expect(new JobStore(file).get(job.id)?.origin).toBe('end_turn')
  })

  it('moves it when a later call names another time', async () => {
    const { store, check, wanted } = setup()
    await check.settle('s1', wanted('2026-11-27T10:00'))
    const id = store.list()[0].id
    expect(await check.settle('s1', { ...wanted('2026-11-28T09:30'), prompt: 'Look again.' })).toBeNull()
    expect(store.list()).toHaveLength(1)
    expect(store.get(id)).toMatchObject({ origin: 'end_turn', nextRunAt: '2026-11-28T09:30:00.000Z', prompt: 'Look again.' })
  })

  it('uses a check that already ran again', async () => {
    const { store, check, wanted } = setup()
    await check.settle('s1', wanted('2026-11-27T10:00'))
    const ran = store.list()[0]
    store.put({ ...ran, endedAt: '2026-11-27T10:00:05.000Z', nextRunAt: null, runCount: 1 })
    await check.settle('s1', wanted('2026-11-29T10:00'))
    expect(store.list()).toHaveLength(1)
    expect(store.get(ran.id)).toMatchObject({ endedAt: null, nextRunAt: '2026-11-29T10:00:00.000Z' })
  })

  it('removes it when a later call names no time, and leaves a job the agent made itself', async () => {
    const { store, jobs, callers, check, wanted } = setup()
    const own = await jobs.handle(callers.s1, { action: 'create', name: 'Ask Acme again', prompt: 'x', at: '2026-11-30T10:00', target: 'self' })
    await check.settle('s1', wanted('2026-11-27T10:00'))
    expect(store.list()).toHaveLength(2)
    expect(await check.settle('s1', wanted(null))).toBeNull()
    expect(store.list().map((job) => job.id)).toEqual([own.job!.id])
    // Nothing to remove: nothing happens.
    expect(await check.settle('s1', wanted(null))).toBeNull()
    expect(store.list()).toHaveLength(1)
  })

  it('keeps one check per session: another session on the same task gets its own, and neither touches the other\'s', async () => {
    const { store, check, wanted } = setup()
    await check.settle('s1', wanted('2026-11-27T10:00'))
    expect(await check.settle('s2', wanted('2026-11-28T10:00'))).toBeNull()
    expect(store.list().map((job) => [job.createdBy, job.name]).sort()).toEqual([['s1', 'Check: Refund from Acme'], ['s2', 'Check: Refund from Acme (s2)']])
    await check.settle('s2', wanted(null))
    expect(store.list().map((job) => job.createdBy)).toEqual(['s1'])
  })

  it('says why in the schedule tool\'s words when the time cannot be set, and keeps the check it had', async () => {
    const { store, check, wanted } = setup()
    expect(await check.settle('s1', wanted('2026-11-20T10:00'))).toMatch(/^at: .* has passed$/)
    expect(store.list()).toHaveLength(0)
    await check.settle('s1', wanted('2026-11-27T10:00'))
    expect(await check.settle('s1', wanted('2026-11-20T10:00'))).toMatch(/has passed$/)
    expect(store.list()[0].nextRunAt).toBe('2026-11-27T10:00:00.000Z')
    expect(await check.settle('nobody', wanted('2026-11-27T10:00'))).toBe('the cockpit does not know this session')
    expect(await check.settle('nobody', wanted(null))).toBeNull()
  })

  it('fits the name into a job name', () => {
    expect(checkName('Refund')).toBe('Check: Refund')
    expect(checkName(null)).toBe('Check: this session')
    const long = checkName('A task with a name that goes on and on, well past what a job name may hold', 'abcd1234')
    expect(long).toHaveLength(60)
    expect(long.endsWith('… (abcd1234)')).toBe(true)
  })
})
