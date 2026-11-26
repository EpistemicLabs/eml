import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordOfSession, sessionJobFacts, sessionScope } from '../src/application/limited-job-scope.js'
import { JobStore } from '../src/job-store.js'
import { newRecord } from '../src/domain/job.js'
import { requestJobs } from '../src/jobs-api.js'
import type { JobCaller } from '../src/application/jobs.js'

// A limited task's session reaches only its own task's schedule. A session whose record cannot be found is read as
// limited here, so the limit fails closed; the tool then looks the task up (tests/jobs.test.ts).

describe('sessionJobFacts', () => {
  it('names the task whose run started a session and whether it is limited', () => {
    expect(sessionJobFacts(null, undefined)).toEqual({ jobId: null, limited: false })
    expect(sessionJobFacts('job-1', { limited: true })).toEqual({ jobId: 'job-1', limited: true })
    expect(sessionJobFacts('job-1', { limited: false })).toEqual({ jobId: 'job-1', limited: false })
    expect(sessionJobFacts('job-1', {})).toEqual({ jobId: 'job-1', limited: false })
  })

  it('counts a session whose record is gone as limited', () => {
    expect(sessionJobFacts('job-1', undefined)).toEqual({ jobId: 'job-1', limited: true })
  })
})

describe('recordOfSession', () => {
  const store = new JobStore(null)
  store.put({ ...newRecord({ id: 'rec-r', spaceId: null }, ''), triggers: [{ type: 'mail', match: [] }], limited: true })
  store.put(newRecord({ id: 'task-t', spaceId: null }, ''))

  it('is the record the ledger\'s jobId names, also when the session works on another task', () => {
    expect(recordOfSession({ jobId: 'rec-r', taskId: 'rec-r' }, store)?.id).toBe('rec-r')
    // A version 1 channel job without a task: its session got a task of its own; the migration re-pointed it to the record.
    expect(recordOfSession({ jobId: 'rec-r', taskId: 'task-t' }, store)).toMatchObject({ id: 'rec-r', limited: true })
  })

  it('is the record of its task when the jobId names no record, and none without either', () => {
    // A session a version 1 job started that did not move onto its task kept that job's id.
    expect(recordOfSession({ jobId: '3414dfd2-old-job', taskId: 'task-t' }, store)?.id).toBe('task-t')
    expect(recordOfSession({ jobId: '3414dfd2-old-job', taskId: 'other' }, store)).toBeUndefined()
    expect(recordOfSession({ jobId: 'job-1', taskId: null }, store)).toBeUndefined()
    // No run started it: no record, whatever task it works on.
    expect(recordOfSession({ jobId: null, taskId: 'task-t' }, store)).toBeUndefined()
  })
})

describe('a session of a version 1 job that still waits to move', () => {
  it('takes that job\'s limits, never the record of its task', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cockpit-limited-scope-')), 'jobs.json')
    const job = {
      id: 'v1-job', name: 'Refund', kind: 'routine', spaceId: null, createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', taskId: 'task-t',
      prompt: 'p', target: { type: 'worker', projectId: 'bp-eml' }, triggers: [{ type: 'mail', match: [] }], toolProfile: null, reply: {}, end: null, notify: 'needs-me',
      paused: false, pausedReason: null, endedAt: null, nextRunAt: null, runCount: 1, failures: 0, limited: true,
    }
    writeFileSync(file, JSON.stringify({ version: 1, timeZone: 'UTC', jobs: { 'v1-job': job }, runs: {}, keys: {} }))
    const store = new JobStore(file, [null])
    // Its task got an unlimited record meanwhile (a wake-up set on it).
    store.put(newRecord({ id: 'task-t', spaceId: null }, ''))
    const entry = { jobId: 'v1-job', taskId: 'task-t' }
    // Launch limits and channel tools: not the task's unlimited record.
    expect(recordOfSession(entry, store)).toBeUndefined()
    // The schedule tool's caller: limited (fails closed), and its scope takes the waiting job's limits.
    expect(sessionJobFacts(entry.jobId, recordOfSession(entry, store))).toEqual({ jobId: 'v1-job', limited: true })
    expect(sessionScope(entry, store)).toMatchObject({ ownTaskId: 'task-t', limits: { id: 'v1-job', limited: true } })
  })
})

describe('requestJobs', () => {
  it('hands the schedule tool only the tool\'s own fields, not the request\'s envelope', async () => {
    const seen: Array<Record<string, unknown>> = []
    const caller: JobCaller = { sessionId: 's', spaceId: null, projectId: null, toolProfile: null, jobId: 'job-1', limited: true }
    const deps = {
      jobs: { handle: async (_caller: JobCaller, input: Record<string, unknown>) => { seen.push(input); return { status: 200, text: 'ok' } } },
      callerOf: (id: string) => (id === 's' ? caller : null),
    }
    const answered = await requestJobs(deps, { kind: 'schedule', token: 't', fromSession: 's', action: 'update', job: 'job-1', at: '2026-11-11T09:00' })
    expect(seen).toEqual([{ action: 'update', job: 'job-1', at: '2026-11-11T09:00' }])
    expect(answered).toEqual({ status: 200, payload: { text: 'ok' } })
    // Only a session the cockpit knows can schedule.
    expect(await requestJobs(deps, { fromSession: 'stranger', action: 'list' })).toMatchObject({ status: 403, payload: { error: { code: 'UNKNOWN_SESSION' } } })
  })
})
