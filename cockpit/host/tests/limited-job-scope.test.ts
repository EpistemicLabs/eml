import { describe, expect, it } from 'vitest'
import { sessionJobFacts } from '../src/application/limited-job-scope.js'
import { requestJobs } from '../src/jobs-api.js'
import type { JobCaller } from '../src/application/jobs.js'

// A limited job's session reaches only its own job, and when that job cannot
// be found it reaches nothing: the limit fails closed.

describe('sessionJobFacts', () => {
  it('names a session\'s job and whether that job is limited', () => {
    expect(sessionJobFacts(null, undefined)).toEqual({ jobId: null, limited: false })
    expect(sessionJobFacts('job-1', { limited: true })).toEqual({ jobId: 'job-1', limited: true })
    expect(sessionJobFacts('job-1', { limited: false })).toEqual({ jobId: 'job-1', limited: false })
    expect(sessionJobFacts('job-1', {})).toEqual({ jobId: 'job-1', limited: false })
  })

  it('counts a session whose job is gone as limited', () => {
    expect(sessionJobFacts('job-1', undefined)).toEqual({ jobId: 'job-1', limited: true })
  })
})

describe('requestJobs', () => {
  it('hands the job tool only the tool\'s own fields, not the request\'s envelope', async () => {
    const seen: Array<Record<string, unknown>> = []
    const caller: JobCaller = { sessionId: 's', spaceId: null, projectId: null, toolProfile: null, jobId: 'job-1', limited: true }
    const deps = {
      jobs: { handle: async (_caller: JobCaller, input: Record<string, unknown>) => { seen.push(input); return { status: 200, text: 'ok' } } },
      callerOf: (id: string) => (id === 's' ? caller : null),
    }
    await requestJobs(deps, { kind: 'schedule', token: 't', fromSession: 's', action: 'update', job: 'job-1', at: '2026-11-11T09:00' })
    expect(seen).toEqual([{ action: 'update', job: 'job-1', at: '2026-11-11T09:00' }])
  })
})
