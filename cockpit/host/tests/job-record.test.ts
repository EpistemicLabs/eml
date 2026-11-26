import { describe, it, expect } from 'vitest'
import { isNewRecord, newRecord, RECORD_GRACE_MS, recordKeeping, scheduleFactsOf, type Job, type JobRun, type TaskStanding } from '../src/domain/job.js'

// What a pass does with a task's record: it stays while this cockpit fires the task's schedule; without one it goes
// when nothing holds it; a closed task's record stops listening first.

const record = (patch: Partial<Job> = {}): Job => ({ ...newRecord({ id: 't1', spaceId: null }, '2026-11-01T00:00:00.000Z'), ...patch })
const run = (status: JobRun['status']): JobRun => ({
  id: `r-${status}`, jobId: 't1', trigger: 'schedule', number: 1, dueAt: '2026-11-26T08:00:00.000Z', createdAt: '2026-11-26T08:00:00.000Z', status, attempts: 0,
  nextAttemptAt: null, sessionId: null, startedAt: null, finishedAt: null, outcome: null, note: null,
})
const mail: Job['triggers'] = [{ type: 'mail', match: [] }]
const keep = (r: Job, standing: TaskStanding, runs: JobRun[] = []) => recordKeeping(r, standing, runs)

describe('recordKeeping', () => {
  it('removes the record of an open task that has no schedule here, no channel trigger and no open run', () => {
    expect(keep(record(), 'open')).toEqual({ stopListening: false, remove: true })
    expect(keep(record({ runCount: 4, failures: 1, notify: 'always' }), 'open', [run('finished'), run('failed'), run('skipped'), run('missed')])).toEqual({ stopListening: false, remove: true })
  })

  it('keeps it while a channel wakes the task, and while a run of it is open', () => {
    expect(keep(record({ triggers: mail }), 'open').remove).toBe(false)
    for (const status of ['waiting', 'starting', 'started'] as const) expect(keep(record(), 'open', [run(status)]).remove).toBe(false)
  })

  it('keeps a limit the user or its maker set while the task is open: a schedule set later starts no session with more', () => {
    expect(keep(record({ limited: true }), 'open').remove).toBe(false)
    expect(keep(record({ toolProfile: { deny: ['Bash'] } as never }), 'open').remove).toBe(false)
    expect(keep(record({ limited: false }), 'open').remove).toBe(true)
  })

  it('never stops an open task listening', () => {
    expect(keep(record({ triggers: mail, pendingApproval: true }), 'open', [run('waiting')]).stopListening).toBe(false)
  })

  it('stops a closed task listening: its channel, lent tools, a pending approval and a run that waits to start', () => {
    expect(keep(record({ triggers: mail }), 'closed').stopListening).toBe(true)
    expect(keep(record({ grants: [{ tool: 'chrome', until: '2026-11-27T00:00:00.000Z', reason: null }] }), 'closed').stopListening).toBe(true)
    expect(keep(record({ pendingApproval: true }), 'closed').stopListening).toBe(true)
    expect(keep(record(), 'closed', [run('waiting')]).stopListening).toBe(true)
    expect(keep(record(), 'closed').stopListening).toBe(false)
  })

  it('removes a closed task\'s record once no session has a run of it; its limits do not hold it', () => {
    expect(keep(record({ triggers: mail, limited: true }), 'closed', [run('waiting'), run('finished')]).remove).toBe(true)
    expect(keep(record({ triggers: mail }), 'closed', [run('started')]).remove).toBe(false)
    expect(keep(record(), 'closed', [run('starting')]).remove).toBe(false)
  })
})

describe('what a record says of its task\'s schedule', () => {
  it('is nothing for a task without a record', () => {
    expect(scheduleFactsOf(undefined, [run('waiting')])).toEqual({})
  })

  it('is the cursor and the wake-up it fired, with no run waiting', () => {
    const kept = record({ cursor: '2026-11-26T08:00:00.000Z', firedWake: '2026-11-25T08:00:00.000Z' })
    expect(scheduleFactsOf(kept, [run('finished'), run('started'), run('skipped')])).toEqual({ cursor: '2026-11-26T08:00:00.000Z', firedWake: '2026-11-25T08:00:00.000Z', waitingRunDueAt: null })
  })

  it('names the due time of a run that waits to start or is being started: that holds the task runner off', () => {
    const late = { ...run('starting'), dueAt: '2026-11-26T09:00:00.000Z' }
    expect(scheduleFactsOf(record(), [run('finished'), run('waiting'), late]).waitingRunDueAt).toBe('2026-11-26T08:00:00.000Z')
    expect(scheduleFactsOf(record(), [run('started'), late]).waitingRunDueAt).toBe('2026-11-26T09:00:00.000Z')
  })

  it('says that the channel waits for the user\'s OK only while it does', () => {
    expect(scheduleFactsOf(record({ pendingApproval: true }), [])).toMatchObject({ needsOk: true })
    expect(scheduleFactsOf(record(), [])).not.toHaveProperty('needsOk')
  })
})

describe('a record that was just made or changed', () => {
  const at = Date.parse('2026-11-26T10:00:00.000Z')
  const changed = record({ updatedAt: '2026-11-26T10:00:00.000Z' })

  it('is new for the grace, counted from its last change and not from when it was made', () => {
    expect(changed.createdAt).toBe('2026-11-01T00:00:00.000Z')
    expect(isNewRecord(changed, at)).toBe(true)
    expect(isNewRecord(changed, at + RECORD_GRACE_MS - 1)).toBe(true)
    expect(isNewRecord(changed, at + RECORD_GRACE_MS)).toBe(false)
  })

  it('the grace spans several of the engine\'s reads of the tasks, which come about once a minute', () => {
    expect(RECORD_GRACE_MS).toBeGreaterThanOrEqual(3 * 60_000)
  })
})
