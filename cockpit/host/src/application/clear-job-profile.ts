import type { Job } from '../domain/job.js'

/** The job store as clearing a job's limits needs it. */
export interface JobRecords {
  get(id: string): Job | undefined
  put(job: Job): void
}

/**
 * The user lifted a job's limits for its future runs too (the chat view's "Restart without
 * limits"): its next sessions start with all tools their space has. A job without limits stays as it is.
 */
export function clearJobProfile(jobs: JobRecords, jobId: string, now = new Date()): void {
  const job = jobs.get(jobId)
  if (!job?.toolProfile) return
  jobs.put({ ...job, toolProfile: null, updatedAt: now.toISOString() })
}
