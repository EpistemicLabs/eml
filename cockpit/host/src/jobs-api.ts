import type * as http from 'node:http'
import type { JobCaller, Jobs } from './application/jobs.js'
import { isTimeZone } from './domain/schedule.js'
import type { JobStore } from './job-store.js'

/**
 * The schedule tool and the user's time zone over HTTP:
 *   POST /api/jobs            from a session (schedule-cli.ts); X-Cockpit-Token = the
 *                             per-boot spawn token. Body: fromSession plus the schedule
 *                             tool's input (application/jobs.ts). Answer: { text, taskId? }.
 *   GET  /api/jobs            the Jobs view, which goes: an empty list of jobs, with the time zone.
 *   GET  /api/jobs/time-zone  the page: the user's time zone (Settings › Preferences); null until one is saved.
 *   PUT  /api/jobs/time-zone  the page: { timeZone, explicit? }. Only an explicit one (the user chose it in
 *                             Settings) replaces a saved zone; without it a browser fills in the zone only
 *                             while none is saved, so the last page loaded never moves the user's times.
 * The spawn inbox carries the session's request as kind 'schedule' (spawn-inbox.ts).
 *
 * What the Jobs view did with one job sits on its task now (tasks-api.ts): pause, resume, run now, remove one
 * repeating time and End schedule as task commands, and the user's own decisions (their OK for new channel
 * addresses, send or draft, the Limited switch, lent tools) under /api/v1/tasks/<id>/record.
 */

export interface JobsApiDeps {
  /** The schedule tool: what answers a session's call (application/jobs.ts). */
  tool: Pick<Jobs, 'handle'>
  /** The user's time zone (jobs.json). */
  zones: Pick<JobStore, 'timeZone' | 'setTimeZone'>
  spawnToken: string
  /** The session as a caller: its space, project, task and tool profile; null when unknown. */
  callerOf(sessionId: string): JobCaller | null
}

type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>

/** A session's request — the one rule for both ways it arrives. The caller has checked the token. */
export async function requestJobs(deps: { jobs: Pick<Jobs, 'handle'>; callerOf: JobsApiDeps['callerOf'] }, body: Record<string, unknown>): Promise<{ status: number; payload: unknown }> {
  // The envelope says who asks and how it came; the schedule tool gets only the tool's own fields.
  const { fromSession, kind: _kind, token: _token, ...input } = body
  const caller = typeof fromSession === 'string' ? deps.callerOf(fromSession) : null
  if (!caller) return { status: 403, payload: { error: { code: 'UNKNOWN_SESSION', message: 'Only a cockpit session can schedule' } } }
  const answer = await deps.jobs.handle(caller, input)
  return { status: answer.status, payload: { text: answer.text, ...(answer.taskId ? { taskId: answer.taskId } : {}) } }
}

export async function handleJobsApi(
  req: http.IncomingMessage, res: http.ServerResponse, deps: JobsApiDeps, pathname: string, method: string, json: Json, readJson: ReadJson,
): Promise<boolean> {
  if (pathname === '/api/jobs' && method === 'POST') {
    if (req.headers['x-cockpit-token'] !== deps.spawnToken) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Only a cockpit session can schedule' } })
      return true
    }
    const result = await requestJobs({ jobs: deps.tool, callerOf: deps.callerOf }, await readJson(req))
    json(res, result.status, result.payload)
    return true
  }
  if (pathname === '/api/jobs' && method === 'GET') {
    // Schedules sit on their tasks (tasks-api.ts): the list stays empty until the page no longer asks for it.
    json(res, 200, { timeZone: deps.zones.timeZone(), jobs: [] })
    return true
  }
  if (pathname === '/api/jobs/time-zone' && method === 'GET') {
    json(res, 200, { timeZone: deps.zones.timeZone() })
    return true
  }
  if (pathname === '/api/jobs/time-zone' && method === 'PUT') {
    const body = await readJson(req)
    const zone = typeof body.timeZone === 'string' ? body.timeZone : ''
    if (!zone || !isTimeZone(zone)) {
      json(res, 400, { error: { code: 'INVALID_TIME_ZONE', message: 'timeZone must be an IANA time zone' } })
      return true
    }
    const saved = deps.zones.timeZone()
    const take = body.explicit === true || saved === null
    if (take) deps.zones.setTimeZone(zone)
    json(res, 200, { timeZone: take ? zone : saved, changed: take && saved !== zone })
    return true
  }
  return false
}
