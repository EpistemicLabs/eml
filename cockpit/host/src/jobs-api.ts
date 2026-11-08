import type * as http from 'node:http'
import type { JobCaller, Jobs } from './application/jobs.js'
import { isTimeZone } from './domain/schedule.js'
import type { JobStore } from './job-store.js'
import type { NotificationFeed } from './notifications.js'
import { JOB_ACTIONS } from './application/jobs.js'

/**
 * Jobs over HTTP (application/jobs.ts):
 *   POST /api/jobs            from a session (schedule-cli.ts); X-Cockpit-Token = the
 *                             per-boot spawn token. Body: fromSession plus the schedule
 *                             tool's input. Answer: { text, job? }.
 *   GET  /api/jobs            the page: every space's jobs with their runs.
 *   PUT  /api/jobs/time-zone  the page: the user's time zone, from their browser.
 *   POST /api/jobs/<id>/<pause|resume|delete|run_now>   the page (Jobs view).
 *   GET  /api/notifications, POST /api/notifications/read { ids? }   the bell.
 * The spawn inbox carries the session's request as kind 'schedule' (spawn-inbox.ts).
 */

export interface JobsApiDeps {
  jobs: Jobs
  store: JobStore
  spawnToken: string
  /** The session as a caller: its space, project and tool profile; null when unknown. */
  callerOf(sessionId: string): JobCaller | null
  feed: NotificationFeed
  /** A space's name for the page; null = main. */
  spaceName(spaceId: string | null): string
  /** Where the page opens a session: its project and whether it runs in the chat view; null when unknown. */
  sessionInfo(sessionId: string): { projectId: string | null; chat: boolean } | null
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
    const jobs = deps.jobs.jobsOf(undefined).map((job) => ({
      ...job, ...deps.jobs.summary(job), spaceName: deps.spaceName(job.spaceId),
      runs: [...deps.store.runs(job.id)].reverse().slice(0, 20).map((run) => ({ ...run, session: run.sessionId ? deps.sessionInfo(run.sessionId) : null })),
    }))
    json(res, 200, { timeZone: deps.store.timeZone(), jobs })
    return true
  }
  const act = pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})\/([a-z_]+)$/)
  if (act && method === 'POST') {
    const job = deps.store.get(act[1])
    const action = act[2]
    if (!job || !(JOB_ACTIONS as readonly string[]).includes(action) || action === 'create' || action === 'list' || action === 'update') {
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'No such job or action' } })
      return true
    }
    // The user acts on any space's job: as a caller of that space.
    const answer = await deps.jobs.handle({ sessionId: null, spaceId: job.spaceId, projectId: null, toolProfile: null }, { action, job: job.id })
    json(res, answer.status, { text: answer.text })
    return true
  }
  if (pathname === '/api/notifications' && method === 'GET') {
    const items = deps.feed.list().map((item) => ({ ...item, session: item.sessionId ? deps.sessionInfo(item.sessionId) : null }))
    json(res, 200, { items, unread: deps.feed.unread() })
    return true
  }
  if (pathname === '/api/notifications/read' && method === 'POST') {
    const body = await readJson(req)
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : undefined
    deps.feed.markRead(ids)
    json(res, 200, { unread: deps.feed.unread() })
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
