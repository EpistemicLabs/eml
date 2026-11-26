import { describe, expect, it } from 'vitest'
import { sessionJobFacts, sessionRecordId } from '../src/application/limited-job-scope.js'
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

describe('sessionRecordId', () => {
  it('reads a run\'s session by the record of its task: a record\'s id is its task\'s id', () => {
    expect(sessionRecordId({ jobId: 't1', taskId: 't1' })).toBe('t1')
    // A session a version 1 job started that did not move onto its task kept that job's id: its task's record counts.
    expect(sessionRecordId({ jobId: '3414dfd2-old-job', taskId: '917985e0-task' })).toBe('917985e0-task')
    expect(sessionRecordId({ jobId: 'job-1', taskId: null })).toBe('job-1')
    // No run started it: no record, whatever task it works on.
    expect(sessionRecordId({ jobId: null, taskId: 't1' })).toBeNull()
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
