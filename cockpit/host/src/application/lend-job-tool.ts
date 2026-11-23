import type { DeliveryOutcome } from '../domain/session-delivery.js'
import { jobTimeZone, type GrantTool, type Job } from '../domain/job.js'
import { formatInZone } from '../domain/schedule.js'

/** The sessions a job started for itself, as lending and taking back a tool need them. */
export interface JobSessions {
  /** The sessions whose ledger entry names the job, newest first. Never a session the user started. */
  sessionsOf(jobId: string): string[]
  /** Its process runs now, in the chat view or a terminal. */
  runs(sessionId: string): boolean
  /** Resolves once the session is not mid-turn; at once when it is not. */
  turnOver(sessionId: string): Promise<void>
  /** Ends its process; it stays resumable. */
  stop(sessionId: string): Promise<void>
  /** A message for the session; resumes a stopped one (application/deliver-message.ts). */
  deliver(sessionId: string, text: string): Promise<DeliveryOutcome>
  /** Fallback zone for a job without a schedule. */
  timeZone(): string
  log(line: string): void
}

const TOOL_NAMES: Record<GrantTool, string> = { chrome: 'Chrome', SendMessage: 'SendMessage' }

/**
 * The user lent a job a tool. A session gets its tools when it starts (channel-job-launch.ts), so
 * the job's newest session is stopped after its current turn and resumed with a note: the same
 * conversation, now with the tool. A job without a session yet gets the tool at its first start.
 */
export async function lendJobTool(deps: JobSessions, job: Job, tool: GrantTool): Promise<void> {
  const sessionId = deps.sessionsOf(job.id)[0]
  if (!sessionId) return
  const grant = job.grants?.find((g) => g.tool === tool)
  if (!grant) return
  if (deps.runs(sessionId)) {
    await deps.turnOver(sessionId)
    if (deps.runs(sessionId)) await deps.stop(sessionId)
  }
  const zone = jobTimeZone(job, deps.timeZone())
  const until = `${formatInZone(Date.parse(grant.until), zone)} (${zone})`
  const outcome = await deps.deliver(sessionId, `The user lent you ${TOOL_NAMES[tool]} until ${until}${grant.reason ? `: ${grant.reason}` : '.'}`)
  deps.log(`[jobs] lent ${tool} to job ${job.id.slice(0, 8)}: session ${sessionId} ${outcome}`)
}
