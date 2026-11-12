import type { GrantTool, Job } from '../domain/job.js'
import type { JobSessions } from './lend-job-tool.js'

/**
 * Lent tools went back (their time is up, the session reported done, or the user took them).
 * Every running session of the job stops after its current turn, never in the middle of one, so
 * its next start comes without them (channel-job-launch.ts reads the grants of then).
 */
export async function takeBackJobTools(deps: JobSessions, job: Job, tools: GrantTool[]): Promise<void> {
  const running = deps.sessionsOf(job.id).filter((sessionId) => deps.runs(sessionId))
  await Promise.all(running.map(async (sessionId) => {
    await deps.turnOver(sessionId)
    if (!deps.runs(sessionId)) return
    await deps.stop(sessionId)
    deps.log(`[jobs] took ${tools.join(', ')} back from job ${job.id.slice(0, 8)}: session ${sessionId} stopped`)
  }))
}
