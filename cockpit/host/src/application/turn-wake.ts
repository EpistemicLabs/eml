import type { EmlApi } from '@engramprotocol/mcp-server'
import type { ScheduleFields } from '../domain/delegation.js'
import { JOB_LIMITS } from '../domain/job.js'
import { parseAt } from '../domain/schedule.js'
import { isOpenTask } from '../domain/schedule-tool.js'
import { clearWake, nextRunOfSchedule, setWake, whileHeldForOk, type ScheduleFacts } from '../domain/task-schedule.js'
import { localTime } from '../domain/schedule.js'
import type { CheckOutcome } from '../domain/turn-state-echo.js'
import { waitsOf, type Wait } from '../domain/task-waits.js'
import type { ToolProfile } from '../domain/tool-profile.js'
import type { CheckFix, CheckTime, WakeEdit } from '../domain/turn-end.js'
import type { JobStore } from '../job-store.js'
import { keepRecord, narrowRecordProfile } from './record-profile.js'
import { editTaskSchedule } from './task-schedule-write.js'

/**
 * What an end_turn call does to the wake-up of the session's task (domain/turn-end.ts wakeEditOf): the task's
 * schedule holds at most one wake-up. A check sets it — the time, the reason the session reads when it fires, this
 * agent as the one it is for (by) and this session as the one that set it, so the cockpit continues it then. It
 * replaces a wake-up the task had and never touches a repeating time. Check "none" removes it. A call without a check
 * keeps it, whoever set it: an ask, a review, a hand-over never clears it.
 *
 * A session without a task has nothing to set a wake-up on, and nothing fires on a closed task: there a check is
 * refused, the rest of the call stands. Every change is written to the task's journal with its cause.
 *
 * A session with narrowed tools that sets a wake-up narrows the task's record with it (application/record-profile.ts):
 * if that session is gone when the wake-up fires, the cockpit starts a new one with the record's tools, and that
 * must never be more than the session that set it had.
 *
 * The answer says what the task's schedule was before and is after the call, the task's status and waits as read,
 * and whether it has a next run once the call is applied: a task that has one needs no check from the agent
 * (domain/turn-end.ts missingOf). While the task's record waits for the user's OK only its wake-up counts
 * (domain/task-schedule.ts whileHeldForOk): the OK holds the repeating times, as every other reader has it.
 */

export interface TurnWakeDeps {
  /** The session's task (the ledger's) and the brain of its space, with the space's agent; null: the cockpit does not know the session. */
  where(sessionId: string): { taskId: string | null; brain: Pick<EmlApi, 'get' | 'post'> | null; agent: string | null; spaceId?: string | null; toolProfile?: ToolProfile | null } | null
  /**
   * What this cockpit keeps per task (job-store.ts): a session whose own tools are narrowed (`where().toolProfile`)
   * narrows the task's record when it sets a wake-up. `where().spaceId`: the space a new record is filed under.
   */
  records?: Pick<JobStore, 'get' | 'put'>
  /**
   * The task still has jobs of before brain schema 24 that are moving onto it (application/job-migration.ts): the
   * migration replaces its schedule with what they say, so nothing is written to it until they have moved.
   */
  moving?(taskId: string): boolean
  /**
   * What this cockpit's record says of the task's schedule (domain/job.ts scheduleFactsOf): a record that waits for
   * the user's OK (`needsOk`) holds the repeating times, and only the wake-up is a next run then. Absent: nothing held.
   */
  scheduleFacts?(taskId: string): ScheduleFacts
  /** The user's time zone now: a call's when is read in it. */
  zone(): string
  now?: () => number
  /** The task's schedule changed: whatever shows it is built again. */
  changed?(): void
  log(line: string): void
}

export interface WakeSettled {
  /** Why the wake-up could not be set or removed, or null; the rest of the call is recorded. */
  problem: string | null
  /** What helps then (domain/turn-end.ts CheckFix). */
  fix?: CheckFix
  /** The task's wake-up as saved: the zone the when was read in and the instant; null when none was set. */
  saved: CheckTime | null
  /** The task has a next run from its schedule now. */
  nextRun: boolean
  /** What the call did to the wake-up; absent when the task could not be read. */
  outcome?: CheckOutcome
  /** The task's schedule before and after the call; absent when the task could not be read. */
  before?: ScheduleFields | null
  after?: ScheduleFields | null
  /** The task as read: its status and its waits (before this turn's wait is routed). */
  task?: { status: string; waits: Wait[]; owners?: string[] }
  /** The zone the times are read in (the user's). */
  zone?: string
}

export interface TurnWake {
  /**
   * Brings the task's wake-up in line with the session's call. `by`: the agent the wake-up is for (the session's).
   * Never throws.
   */
  settle(sessionId: string, wanted: { edit: WakeEdit; by?: string | null }): Promise<WakeSettled>
}

export const NO_TASK = 'this session works on no task, and a wake-up is set on a task'
export const TASK_CLOSED = 'the session\'s task is closed, and nothing fires on a closed task'

/** The task's schedule after a turn's end: the wake-up set (`at`: the instant), removed, or kept as it is. */
export function scheduleAfterTurn(
  schedule: ScheduleFields | null, edit: WakeEdit, by: { sessionId: string; agent?: string | null; at?: string; zone: string },
): ScheduleFields | null {
  if (edit.kind === 'set') return setWake(schedule, { at: by.at ?? edit.when, why: edit.why, by: by.agent ?? null, bySession: by.sessionId, timeZone: by.zone })
  if (edit.kind === 'remove') return clearWake(schedule)
  return schedule
}

/** The journal line of a wake-up a turn's end set or removed: its cause, who, and the time as the user reads it. */
export function turnWakeNote(before: ScheduleFields | null, after: ScheduleFields | null, agent: string | null | undefined, zone: string): string | null {
  const who = agent ?? 'The agent'
  const local = (at: string) => localTime(at, zone)
  if (after?.at && after.at !== before?.at) return `Turn end: ${who} set the wake-up for ${local(after.at)}${after.why ? `: ${after.why.replace(/[.\s]+$/, '')}` : ''}${before?.at ? ` (it replaces ${local(before.at)})` : ''}.`
  if (after?.at && after.why !== before?.why) return `Turn end: ${who} kept the wake-up at ${local(after.at)} with a new reason: ${(after.why ?? 'none').replace(/[.\s]+$/, '')}.`
  if (before?.at && !after?.at) return `Turn end: ${who} removed the wake-up (it was for ${local(before.at)}).`
  return null
}

class Refused extends Error {
  constructor(message: string, readonly fix: CheckFix) { super(message) }
}

export function createTurnWake(deps: TurnWakeDeps): TurnWake {
  const now = () => deps.now?.() ?? Date.now()

  const settle = async (sessionId: string, wanted: { edit: WakeEdit; by?: string | null }): Promise<WakeSettled> => {
    const { edit } = wanted
    const where = deps.where(sessionId)
    if (!where) throw new Refused('the cockpit does not know this session', 'none')
    if (!where.taskId) throw new Refused(NO_TASK, 'none')
    if (!where.brain) throw new Refused('the space of the session\'s task has no brain to write to', 'again')
    if (edit.kind !== 'keep' && deps.moving?.(where.taskId)) throw new Refused('the task\'s jobs from before are still moving onto it; in a minute it can be set', 'again')
    const zone = deps.zone()
    const agent = wanted.by ?? where.agent
    let at: string | undefined
    if (edit.kind === 'set') {
      const time = parseAt(edit.when, zone)
      if (time === null) throw new Refused(`"${edit.when}" is not a time`, 'time')
      if (time - now() > JOB_LIMITS.maxAheadMs) throw new Refused('at most a year ahead', 'time')
      at = new Date(time).toISOString()
    }
    let open = true
    // A call that keeps the wake-up writes nothing: the task is read for the answer only.
    const written = await editTaskSchedule(where.brain, where.taskId, (schedule, task) => {
      open = isOpenTask(task)
      if (!open) {
        if (edit.kind === 'set') throw new Refused(TASK_CLOSED, 'none')
        return schedule
      }
      return scheduleAfterTurn(schedule, edit, { sessionId, agent, at, zone })
    }, { text: (before, after, changed) => (changed ? turnWakeNote(before, after, agent, zone) : null), onlyWithChange: true })
    // After the schedule is on the task: the tools a new session of the task starts with are at most this session's.
    if (edit.kind === 'set' && open && written.schedule?.at && deps.records) {
      const narrowed = narrowRecordProfile(deps.records, { id: where.taskId, spaceId: where.spaceId ?? null }, { sessionId, toolProfile: where.toolProfile ?? null }, new Date(now()).toISOString())
      if (narrowed) deps.log(`[wake] ${sessionId.slice(0, 8)} task ${where.taskId.slice(0, 8)}: its sessions get at most this session's tools`)
      // Ending a turn with a check is an explicit act here: this cockpit keeps the task's record, which is what makes
      // it fire a task no member owns.
      keepRecord(deps.records, { id: where.taskId, spaceId: where.spaceId ?? null }, new Date(now()).toISOString(), sessionId)
    }
    if (written.changed) {
      deps.changed?.()
      deps.log(`[wake] ${sessionId.slice(0, 8)} task ${where.taskId.slice(0, 8)}: wake-up ${edit.kind === 'set' ? `set for ${edit.when} (${zone}) = ${at}` : 'removed'}`)
    }
    const before = written.before
    const after = written.schedule
    const outcome: CheckOutcome = edit.kind === 'set' && after?.at ? 'set'
      : before?.at && !after?.at ? 'removed'
        : after?.at ? 'kept' : 'none'
    const saved = edit.kind === 'set' && after?.at ? { at: Date.parse(after.at), zone } : null
    const firing = deps.scheduleFacts?.(where.taskId).needsOk ? whileHeldForOk(after) : after
    return {
      problem: null, saved, nextRun: open && nextRunOfSchedule(firing, now()) !== null,
      outcome, before, after, zone,
      task: {
        status: written.task.status,
        waits: waitsOf(written.task.properties as { waits?: unknown; waiting_on?: unknown } | undefined),
        ...(written.task.properties?.assignee_ids ? { owners: written.task.properties.assignee_ids } : {}),
      },
    }
  }

  return {
    async settle(sessionId, wanted) {
      try {
        return await settle(sessionId, wanted)
      } catch (err) {
        const kind = wanted.edit.kind
        // A session without a task that keeps (or removes) nothing: not worth a line.
        if (kind === 'set' || !(err instanceof Refused)) deps.log(`[wake] ${sessionId.slice(0, 8)} wake-up not ${kind === 'set' ? 'set' : kind === 'remove' ? 'removed' : 'read'}: ${(err as Error).message}`)
        if (kind === 'keep' || (kind === 'remove' && err instanceof Refused && err.fix === 'none')) return { problem: null, saved: null, nextRun: false }
        return err instanceof Refused
          ? { problem: err.message, fix: err.fix, saved: null, nextRun: false }
          : { problem: `the task's schedule could not be written (${(err as Error).message})`, fix: 'again', saved: null, nextRun: false }
      }
    },
  }
}
