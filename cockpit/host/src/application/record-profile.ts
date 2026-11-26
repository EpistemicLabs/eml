import { newRecord, type Job } from '../domain/job.js'
import { narrowedProfile } from '../domain/schedule-tool.js'
import type { ToolProfile } from '../domain/tool-profile.js'
import type { JobStore } from '../job-store.js'

/**
 * A task's sessions get at most the tools of a session that set something to wake the task: the record's tool
 * profile is what a new session of the task starts with (application/job-runner.ts), so a session with narrowed
 * tools that sets a wake-up narrows the record to what it has itself — by the schedule tool's rule
 * (domain/schedule-tool.ts narrowedProfile): never wider than the record was, never wider than the session is.
 *
 *   - a session with all its tools: nothing changes, and no record is made;
 *   - a narrowed session, no record: a record is made with its profile;
 *   - a narrowed session, a wider record (or one without a profile): the record is narrowed to what both allow;
 *   - a narrowed session, a narrower record: nothing changes.
 *
 * Call it AFTER the schedule is on the task. A record that holds a profile stays while its task is open
 * (domain/job.ts recordKeeping), so the limit outlives the wake-up it came with. Returns the record when it was
 * written, else null.
 */
export function narrowRecordProfile(
  store: Pick<JobStore, 'get' | 'put'>, task: { id: string; spaceId: string | null }, session: { sessionId: string; toolProfile: ToolProfile | null }, at: string,
): Job | null {
  if (!session.toolProfile) return null
  const before = store.get(task.id)
  const toolProfile = narrowedProfile(before ? before.toolProfile : undefined, session.toolProfile, undefined) as ToolProfile | null
  if (before && JSON.stringify(before.toolProfile) === JSON.stringify(toolProfile)) return null
  const next: Job = { ...(before ?? newRecord(task, at, session.sessionId)), toolProfile, updatedAt: at }
  store.put(next)
  return next
}
