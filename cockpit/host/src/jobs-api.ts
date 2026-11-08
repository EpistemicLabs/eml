import type * as http from 'node:http'
import type { JobCaller, Jobs } from './application/jobs.js'
import { isTimeZone } from './domain/schedule.js'
import type { JobStore } from './job-store.js'

/**
 * Jobs over HTTP (application/jobs.ts):
 *   POST /api/jobs            from a session (schedule-cli.ts); X-Cockpit-Token = the
 *                             per-boot spawn token. Body: fromSession plus the schedule
 *                             tool's input. Answer: { text, job? }.
 *   GET  /api/jobs            the page: every space's jobs with their runs.
 *   PUT  /api/jobs/time-zone  the page: the user's time zone, from their browser.
 * The spawn inbox carries the session's request as kind 'schedule' (spawn-inbox.ts).
 */

export interface JobsApiDeps {
  jobs: Jobs
  store: JobStore
  spawnToken: string
  /** The session as a caller: its space, project and tool profile; null when unknown. */
  callerOf(sessionId: string): JobCaller | null
}

type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>

/** A session's request — the one rule for both ways it arrives. The caller has checked the token. */
export async function requestJobs(deps: { jobs: Pick<Jobs, 'handle'>; callerOf: JobsApiDeps['callerOf'] }, body: Record<string, unknown>): Promise<{ status: number; payload: unknown }> {
  const caller = typeof body.fromSession === 'string' ? deps.callerOf(body.fromSession) : null
  if (!caller) return { status: 403, payload: { error: { code: 'UNKNOWN_SESSION', message: 'Only a cockpit session can schedule jobs' } } }
  const answer = await deps.jobs.handle(caller, body)
  return { status: answer.status, payload: { text: answer.text, ...(answer.job ? { job: answer.job } : {}) } }
}

export async function handleJobsApi(
  req: http.IncomingMessage, res: http.ServerResponse, deps: JobsApiDeps, pathname: string, method: string, json: Json, readJson: ReadJson,
): Promise<boolean> {
  if (pathname === '/api/jobs' && method === 'POST') {
    if (req.headers['x-cockpit-token'] !== deps.spawnToken) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Only a cockpit session can schedule jobs' } })
      return true
    }
    const result = await requestJobs(deps, await readJson(req))
    json(res, result.status, result.payload)
    return true
  }
  if (pathname === '/api/jobs' && method === 'GET') {
    const jobs = deps.jobs.jobsOf(undefined).map((job) => ({ ...job, runs: deps.store.runs(job.id) }))
    json(res, 200, { timeZone: deps.store.timeZone(), jobs })
    return true
  }
  if (pathname === '/api/jobs/time-zone' && method === 'PUT') {
    const body = await readJson(req)
    const zone = typeof body.timeZone === 'string' ? body.timeZone : ''
    if (!zone || !isTimeZone(zone)) {
      json(res, 400, { error: { code: 'INVALID_TIME_ZONE', message: 'timeZone must be an IANA time zone' } })
      return true
    }
    deps.store.setTimeZone(zone)
    json(res, 200, { timeZone: zone })
    return true
  }
  return false
}
