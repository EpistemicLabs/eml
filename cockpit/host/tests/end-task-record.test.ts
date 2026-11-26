import { describe, it, expect } from 'vitest'
import { endTaskRecord } from '../src/application/end-task-record.js'
import { JobStore } from '../src/job-store.js'
import { CLOSED_BEFORE_START, isHeld, newRecord, type JobRun } from '../src/domain/job.js'

const NOW = Date.parse('2026-11-26T10:00:00.000Z')
const run = (id: string, status: JobRun['status']): JobRun => ({
  id, jobId: 't1', trigger: 'schedule', number: 1, dueAt: '2026-11-26T08:00:00.000Z', createdAt: '2026-11-26T08:00:00.000Z', status, attempts: 0,
  nextAttemptAt: null, sessionId: null, startedAt: null, finishedAt: null, outcome: null, note: null,
})

describe('ending what this cockpit keeps for a task\'s schedule', () => {
  it('takes its channels and lent tools off, skips a run that waits to start and leaves one a session has', () => {
    const store = new JobStore(null)
    store.put({
      ...newRecord({ id: 't1', spaceId: null }, '2026-11-01T00:00:00.000Z'), triggers: [{ type: 'mail', match: [] }], pendingApproval: true, runCount: 2,
      grants: [{ tool: 'chrome', until: '2026-11-26T11:00:00.000Z', reason: null }, { tool: 'SendMessage', until: '2026-11-26T09:00:00.000Z', reason: null }],
    })
    store.addRun(run('r1', 'waiting'))
    store.addRun(run('r2', 'started'))
    const taken: string[][] = []
    endTaskRecord(store, 't1', NOW, (_record, tools) => taken.push(tools))
    expect(store.get('t1')).toMatchObject({ id: 't1', triggers: [], grants: [], runCount: 2, updatedAt: '2026-11-26T10:00:00.000Z' })
    expect(store.get('t1')).not.toHaveProperty('pendingApproval')
    expect(store.runs('t1').map((r) => [r.id, r.status, r.note])).toEqual([['r1', 'skipped', 'its job was ended before it started'], ['r2', 'started', null]])
    // only the tools still lent go back
    expect(taken).toEqual([['chrome']])
    // again: nothing more to do
    endTaskRecord(store, 't1', NOW + 1000, (_record, tools) => taken.push(tools))
    expect(taken).toHaveLength(1)
    expect(store.get('t1')?.updatedAt).toBe('2026-11-26T10:00:00.000Z')
  })

  it('says why a waiting run never started when the task was closed some other way', () => {
    const store = new JobStore(null)
    store.put({ ...newRecord({ id: 't1', spaceId: null }, '2026-11-01T00:00:00.000Z'), triggers: [{ type: 'mail', match: [] }] })
    store.addRun(run('r1', 'waiting'))
    endTaskRecord(store, 't1', NOW, undefined, CLOSED_BEFORE_START)
    expect(store.runs('t1').map((r) => [r.status, r.note])).toEqual([['skipped', 'its task was closed before it started']])
    expect(store.get('t1')?.triggers).toEqual([])
  })

  it('a task without a record has nothing to end', () => {
    const store = new JobStore(null)
    endTaskRecord(store, 'none', NOW)
    expect(store.list()).toEqual([])
  })
})

describe('a record this cockpit holds back', () => {
  it('waits for the user\'s OK, or the cockpit paused it after failures; a pause the user set is on the task', () => {
    const record = newRecord({ id: 't1', spaceId: null }, '2026-11-01T00:00:00.000Z')
    expect(isHeld(record)).toBe(false)
    expect(isHeld({ ...record, pendingApproval: true })).toBe(true)
    expect(isHeld({ ...record, pausedReason: '3 failed runs in a row' })).toBe(true)
  })
})
