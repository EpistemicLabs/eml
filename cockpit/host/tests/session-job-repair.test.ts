import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repairSessionJobIds } from '../src/application/session-job-repair.js'
import { JobStore } from '../src/job-store.js'
import { newRecord } from '../src/domain/job.js'

type Entry = { sessionId: string; jobId: string | null; taskId: string | null }

/** The ledger as the repair sees it: its sessions, and the jobId writes, counted. */
function ledgerOf(entries: Entry[]) {
  const sessions = new Map(entries.map((entry) => [entry.sessionId, { ...entry }]))
  const writes: Array<[string, string | null]> = []
  return {
    writes,
    get: (id: string) => sessions.get(id),
    list: () => [...sessions.values()],
    setJobId: (sessionId: string, jobId: string | null) => {
      const entry = sessions.get(sessionId)
      if (!entry || entry.jobId === jobId) return
      writes.push([sessionId, jobId])
      entry.jobId = jobId
    },
  }
}

const jobsFile = (content?: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'cockpit-session-job-repair-')), 'jobs.json')
  if (content !== undefined) writeFileSync(file, content)
  return file
}

const v1Job = (id: string, taskId: string) => ({
  id, name: 'Refund', kind: 'routine', spaceId: null, createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', taskId,
  prompt: 'p', target: { type: 'worker', projectId: 'bp-eml' }, triggers: [{ type: 'mail', match: [] }], toolProfile: null, reply: {}, end: null, notify: 'needs-me',
  paused: false, pausedReason: null, endedAt: null, nextRunAt: null, runCount: 1, failures: 0,
})

// A ledger jobId names a record or a version 1 job that still waits; any other id is replaced at start by the
// session's task id when it has one.
describe('repairSessionJobIds', () => {
  it('re-points a stale entry to its task once, and leaves a correct one and one without a task alone', () => {
    const store = new JobStore(jobsFile(JSON.stringify({ version: 1, timeZone: 'UTC', jobs: { 'v1-waits': v1Job('v1-waits', 't9') }, runs: {}, keys: {} })), [null])
    store.put(newRecord({ id: 'rec-1', spaceId: null }, ''))
    const ledger = ledgerOf([
      { sessionId: 'stale', jobId: '3414dfd2-old-job', taskId: '917985e0-task' },
      { sessionId: 'no-task', jobId: 'old-job-2', taskId: null },
      { sessionId: 'record', jobId: 'rec-1', taskId: 'other-task' },
      { sessionId: 'waiting', jobId: 'v1-waits', taskId: 't9-session' },
      { sessionId: 'free', jobId: null, taskId: 't3' },
    ])
    expect(repairSessionJobIds(ledger, store)).toBe(1)
    expect(ledger.get('stale')!.jobId).toBe('917985e0-task')
    // Without a task it keeps its id: it stays as limited as it was.
    expect(ledger.get('no-task')!.jobId).toBe('old-job-2')
    expect(ledger.get('record')!.jobId).toBe('rec-1')
    expect(ledger.get('waiting')!.jobId).toBe('v1-waits')
    expect(ledger.get('free')!.jobId).toBeNull()
    // Again: nothing left to change.
    expect(repairSessionJobIds(ledger, store)).toBe(0)
    expect(ledger.writes).toEqual([['stale', '917985e0-task']])
  })

  it('does not count an entry whose record went while it already names its task', () => {
    const ledger = ledgerOf([{ sessionId: 's', jobId: 't1', taskId: 't1' }])
    expect(repairSessionJobIds(ledger, new JobStore(jobsFile()))).toBe(0)
    expect(ledger.writes).toEqual([])
  })

  it('changes nothing while jobs.json could not be read: every id would look stale', () => {
    const store = new JobStore(jobsFile('{ not json'))
    expect(store.notUsable()).not.toBeNull()
    const ledger = ledgerOf([{ sessionId: 'stale', jobId: 'rec-1', taskId: 'task-1' }])
    expect(repairSessionJobIds(ledger, store)).toBe(0)
    expect(ledger.writes).toEqual([])
  })

  it('in a fresh home without jobs.json leaves an entry without a task as it is', () => {
    const ledger = ledgerOf([{ sessionId: 'no-task', jobId: 'old-job', taskId: null }, { sessionId: 'stale', jobId: 'old-job-2', taskId: 'task-2' }])
    expect(repairSessionJobIds(ledger, new JobStore(jobsFile()))).toBe(1)
    expect(ledger.writes).toEqual([['stale', 'task-2']])
  })
})
