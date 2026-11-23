import { describe, expect, it } from 'vitest'
import { clearJobProfile } from '../src/application/clear-job-profile.js'
import type { Job } from '../src/domain/job.js'

const job = (toolProfile: Job['toolProfile']): Job => ({
  id: 'job-1', name: 'Weekly analysis', toolProfile, updatedAt: '2026-11-17T13:29:16.714Z',
} as unknown as Job)

/** A job store as clearing needs it, holding one job. */
function store(initial: Job) {
  const jobs = new Map([[initial.id, initial]])
  const puts: Job[] = []
  return { get: (id: string) => jobs.get(id), put: (j: Job) => { puts.push(j); jobs.set(j.id, j) }, puts }
}

describe('clearJobProfile', () => {
  it('drops the job\'s limits for its future runs and marks it changed', () => {
    const jobs = store(job({ deniedTools: ['mcp__gmail__send_email'], mcpServers: null }))
    clearJobProfile(jobs, 'job-1', new Date('2026-11-23T05:00:00.000Z'))
    expect(jobs.get('job-1')).toMatchObject({ toolProfile: null, updatedAt: '2026-11-23T05:00:00.000Z', name: 'Weekly analysis' })
  })

  it('leaves a job without limits as it is', () => {
    const jobs = store(job(null))
    clearJobProfile(jobs, 'job-1', new Date('2026-11-23T05:00:00.000Z'))
    expect(jobs.puts).toEqual([])
    expect(jobs.get('job-1')!.updatedAt).toBe('2026-11-17T13:29:16.714Z')
  })

  it('does nothing for a job that is gone', () => {
    const jobs = store(job({ deniedTools: ['Bash'], mcpServers: null }))
    clearJobProfile(jobs, 'job-2')
    expect(jobs.puts).toEqual([])
  })
})
