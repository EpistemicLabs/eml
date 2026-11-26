import { describe, it, expect } from 'vitest'
import { repairSessionJobIds } from '../src/application/session-job-repair.js'

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

// A home that ran the migration of jobs.json to version 2 before it re-pointed the sessions of dropped jobs keeps
// sessions whose jobId is a version 1 job's id: neither a record's nor a job's that still waits to move.
describe('repairSessionJobIds', () => {
  it('re-points a stale entry to its task once, and leaves a correct one alone', () => {
    const ledger = ledgerOf([
      { sessionId: 'stale', jobId: '3414dfd2-old-job', taskId: '917985e0-task' },
      { sessionId: 'no-task', jobId: 'old-job-2', taskId: null },
      { sessionId: 'record', jobId: 'rec-1', taskId: 'rec-1' },
      { sessionId: 'waiting', jobId: 'v1-waits', taskId: 't9' },
      { sessionId: 'free', jobId: null, taskId: 't3' },
    ])
    const known = (id: string) => id === 'rec-1' || id === 'v1-waits'
    expect(repairSessionJobIds(ledger, known)).toBe(2)
    expect(ledger.get('stale')!.jobId).toBe('917985e0-task')
    expect(ledger.get('no-task')!.jobId).toBeNull()
    expect(ledger.get('record')!.jobId).toBe('rec-1')
    expect(ledger.get('waiting')!.jobId).toBe('v1-waits')
    expect(ledger.get('free')!.jobId).toBeNull()
    // Again: nothing left to change.
    expect(repairSessionJobIds(ledger, known)).toBe(0)
    expect(ledger.writes).toHaveLength(2)
  })

  it('does not count an entry whose record went while it already names its task', () => {
    const ledger = ledgerOf([{ sessionId: 's', jobId: 't1', taskId: 't1' }])
    expect(repairSessionJobIds(ledger, () => false)).toBe(0)
    expect(ledger.writes).toEqual([])
  })
})
