import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Jobs, type JobCaller } from '../src/application/jobs.js'
import { checkName, createTurnCheck } from '../src/application/turn-check.js'
import { JobStore } from '../src/job-store.js'
import type { JobV1 } from '../src/domain/job-v1.js'

const NOW = Date.parse('2026-11-25T08:00:00Z')

function setup(initial = 'UTC') {
  let zone = initial
  const file = join(mkdtempSync(join(tmpdir(), 'cockpit-turn-check-')), 'jobs.json')
  const store = new JobStore<JobV1>(file)
  const jobs = new Jobs({
    store, runner: { runNow: () => null, tick: async () => {} }, now: () => NOW,
    resolveProject: async () => 'bp-eml', findSession: () => null, addressOf: (id) => `eml-${id}`,
    providerKnown: () => true, defaultTimeZone: () => zone,
  })
  const callers: Record<string, JobCaller> = {
    s1: { sessionId: 's1', spaceId: null, projectId: 'bp-eml', toolProfile: null, taskId: 't1' },
    s2: { sessionId: 's2', spaceId: null, projectId: 'bp-eml', toolProfile: null, taskId: 't1' },
  }
  const logs: string[] = []
  const check = createTurnCheck({ jobs, store, callerOf: (id) => callers[id] ?? null, zone: () => zone, log: (l) => logs.push(l) })
  const wanted = (at: string | null) => ({ at, taskName: 'Refund from Acme', prompt: 'The check is due.' })
  return { file, store, jobs, callers, check, wanted, logs, setZone: (next: string) => { zone = next } }
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
    // The mark is kept with the job.
    expect(new JobStore<JobV1>(file).get(job.id)?.origin).toBe('end_turn')
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

  it('removes a second check of the same session, whatever the call asks for', async () => {
    const { store, jobs, callers, check, wanted } = setup()
    await check.settle('s1', wanted('2026-11-27T10:00'))
    // A second one, as an earlier version or a race could leave it.
    const second = await jobs.handle(callers.s1, { action: 'create', name: 'Check: an older task', prompt: 'x', at: '2026-11-30T10:00', target: 'self' })
    store.put({ ...second.job!, origin: 'end_turn' })
    expect(store.list()).toHaveLength(2)
    await check.settle('s1', wanted('2026-11-28T10:00'))
    expect(store.list().map((job) => job.nextRunAt)).toEqual(['2026-11-28T10:00:00.000Z'])
    store.put({ ...second.job!, origin: 'end_turn' })
    await check.settle('s1', wanted(null))
    expect(store.list()).toEqual([])
  })

  it('ends a check whose own run is still open instead of removing it: the run is still to be settled', async () => {
    const { store, check, wanted } = setup()
    await check.settle('s1', wanted('2026-11-27T10:00'))
    const job = store.list()[0]
    // The check fired and woke the session; that turn ends without a time.
    const run = { id: 'r1', jobId: job.id, number: 1, trigger: 'schedule' as const, dueAt: job.nextRunAt!, status: 'started' as const, attempts: 1, nextAttemptAt: null, sessionId: 's1', startedAt: '2026-11-27T10:00:01.000Z', finishedAt: null, outcome: null, note: null }
    store.addRun(run)
    store.put({ ...job, nextRunAt: null, runCount: 1 })
    expect(await check.settle('s1', wanted(null))).toBeNull()
    expect(store.get(job.id)).toMatchObject({ origin: 'end_turn', nextRunAt: null })
    expect(store.get(job.id)!.endedAt).not.toBeNull()
    expect(store.runs(job.id)).toMatchObject([{ id: 'r1', status: 'started' }])
    // Ended, it is this session's check still: a later call with a time uses it again.
    await check.settle('s1', wanted('2026-11-29T10:00'))
    expect(store.list()).toHaveLength(1)
    expect(store.get(job.id)).toMatchObject({ endedAt: null, nextRunAt: '2026-11-29T10:00:00.000Z' })
  })

  it('takes a check that is used again along to the task the session works on now', async () => {
    const { store, callers, check, wanted } = setup()
    await check.settle('s1', wanted('2026-11-27T10:00'))
    const id = store.list()[0].id
    callers.s1 = { ...callers.s1, taskId: 't2' }
    await check.settle('s1', { ...wanted('2026-11-28T10:00'), taskName: 'Offer for Globex' })
    expect(store.list()).toHaveLength(1)
    expect(store.get(id)).toMatchObject({ taskId: 't2', name: 'Check: Offer for Globex', nextRunAt: '2026-11-28T10:00:00.000Z' })
    // Another session's check on that task has the name already: this one says whose it is.
    callers.s2 = { ...callers.s2, taskId: 't3' }
    await check.settle('s2', { ...wanted('2026-11-28T11:00'), taskName: 'Invoice for Initech' })
    callers.s1 = { ...callers.s1, taskId: 't3' }
    await check.settle('s1', { ...wanted('2026-11-28T12:00'), taskName: 'Invoice for Initech' })
    expect(store.get(id)).toMatchObject({ taskId: 't3', name: 'Check: Invoice for Initech (s1)' })
    // Moved again on the same task, it keeps its own name: it does not clash with itself.
    await check.settle('s1', { ...wanted('2026-11-28T13:00'), taskName: 'Offer for Globex' })
    await check.settle('s1', { ...wanted('2026-11-28T14:00'), taskName: 'Offer for Globex' })
    expect(store.get(id)!.name).toBe('Check: Offer for Globex')
    // A session without a task any more: the check is on none.
    callers.s1 = { ...callers.s1, taskId: null }
    await check.settle('s1', { ...wanted('2026-11-28T15:00'), taskName: null })
    expect(store.get(id)).toMatchObject({ taskId: null, name: 'Check: this session' })
  })

  it('never throws: what goes wrong is the reason the check was not set, and a removal that fails is nobody\'s problem', async () => {
    const { store, wanted } = setup()
    const logs: string[] = []
    const broken = createTurnCheck({
      jobs: { handle: async () => { throw new Error('the job store is locked') } }, store,
      callerOf: () => ({ sessionId: 's1', spaceId: null, projectId: 'bp-eml', toolProfile: null, taskId: 't1' }), log: (l) => logs.push(l),
    })
    expect(await broken.settle('s1', wanted('2026-11-27T10:00'))).toBe('the job store is locked')
    const reading = createTurnCheck({ ...{ jobs: { handle: async () => ({ status: 200, text: '' }) }, callerOf: () => null, log: (l: string) => logs.push(l) }, store: { list: () => { throw new Error('unreadable') }, put: () => {}, runs: () => [] } })
    expect(await reading.settle('s1', wanted(null))).toBeNull()
    expect(await reading.settle('s1', wanted('2026-11-27T10:00'))).toBe('unreadable')
    expect(logs).toEqual(['[check] s1 failed: the job store is locked', '[check] s1 failed: unreadable', '[check] s1 failed: unreadable'])
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

  it('keeps the task\'s schedule on while the check is set, and off once a call without a time took it away', async () => {
    const { store, check, wanted } = setup()
    // A check that has not ended is a time still set for the task.
    const scheduled = () => store.list().some((job) => job.taskId === 't1' && !job.endedAt)
    expect(scheduled()).toBe(false)
    await check.settle('s1', wanted('2026-11-27T10:00'))
    expect(scheduled()).toBe(true)
    // The hand-over for review names no time: the check goes, and the review closes the task.
    await check.settle('s1', wanted(null))
    expect(scheduled()).toBe(false)
    // Also when the check's own run is still open: the check is ended, which is what counts.
    await check.settle('s1', wanted('2026-11-27T10:00'))
    const job = store.list()[0]
    store.addRun({ id: 'r1', jobId: job.id, number: 1, trigger: 'schedule', dueAt: job.nextRunAt!, status: 'started', attempts: 1, nextAttemptAt: null, sessionId: 's1', startedAt: '2026-11-27T10:00:01.000Z', finishedAt: null, outcome: null, note: null })
    await check.settle('s1', wanted(null))
    expect(store.list()).toHaveLength(1)
    expect(scheduled()).toBe(false)
  })

  it('reads the time in the user\'s zone while the process runs in UTC, and logs the zone and the instant saved', async () => {
    const { store, check, wanted, jobs, callers, logs } = setup('Asia/Bangkok')
    expect(await check.settle('s1', wanted('2026-11-26T20:15'))).toBeNull()
    const [job] = store.list()
    // 20:15 in Bangkok, not 20:15 UTC.
    expect(job).toMatchObject({ triggers: [{ type: 'schedule', at: '2026-11-26T13:15:00.000Z', timeZone: 'Asia/Bangkok' }], nextRunAt: '2026-11-26T13:15:00.000Z' })
    expect(logs.at(-1)).toMatch(/set for 2026-11-26T20:15 \(Asia\/Bangkok\) = 2026-11-26T13:15:00\.000Z$/)
    await check.settle('s1', wanted('2026-11-27T09:00'))
    expect(logs.at(-1)).toMatch(/moved to 2026-11-27T09:00 \(Asia\/Bangkok\) = 2026-11-27T02:00:00\.000Z$/)
    // The schedule tool's own default is the same zone.
    const own = await jobs.handle(callers.s1, { action: 'create', name: 'Ask Acme again', prompt: 'x', at: '2026-11-28T08:00', target: 'self' })
    expect(own.job?.triggers).toEqual([{ type: 'schedule', at: '2026-11-28T01:00:00.000Z', timeZone: 'Asia/Bangkok' }])
    // One the user names in another zone keeps that zone.
    const berlin = await jobs.handle(callers.s1, { action: 'create', name: 'Berlin call', prompt: 'x', at: '2026-11-28T08:00', timezone: 'Europe/Berlin', target: 'self' })
    expect(berlin.job?.triggers).toEqual([{ type: 'schedule', at: '2026-11-28T07:00:00.000Z', timeZone: 'Europe/Berlin' }])
  })

  it('reads a moved check\'s time in the zone the user has now, and tells the saved instant', async () => {
    const { store, check, wanted, setZone } = setup('UTC')
    expect(check.saved('s1')).toBeNull()
    await check.settle('s1', wanted('2026-11-26T20:15'))
    expect(check.saved('s1')).toEqual({ at: Date.parse('2026-11-26T20:15:00Z'), zone: 'UTC' })
    setZone('Asia/Makassar')
    await check.settle('s1', wanted('2026-11-27T09:00'))
    expect(store.list()[0].triggers).toEqual([{ type: 'schedule', at: '2026-11-27T01:00:00.000Z', timeZone: 'Asia/Makassar' }])
    expect(check.saved('s1')).toEqual({ at: Date.parse('2026-11-27T01:00:00Z'), zone: 'Asia/Makassar' })
    await check.settle('s1', wanted(null))
    expect(check.saved('s1')).toBeNull()
  })

  it('fits the name into a job name', () => {
    expect(checkName('Refund')).toBe('Check: Refund')
    expect(checkName(null)).toBe('Check: this session')
    const long = checkName('A task with a name that goes on and on, well past what a job name may hold', 'abcd1234')
    expect(long).toHaveLength(60)
    expect(long.endsWith('… (abcd1234)')).toBe(true)
  })
})
