import type { EmlApi } from '@engramprotocol/mcp-server'
import type { ScheduleFields } from '../domain/delegation.js'
import { JOB_LIMITS } from '../domain/job.js'
import { parseAt } from '../domain/schedule.js'
import { clearWake, nextRunOfSchedule, setWake } from '../domain/task-schedule.js'
import type { CheckFix, CheckTime, WakeEdit } from '../domain/turn-end.js'
import { editTaskSchedule } from './task-schedule-write.js'

/**
 * What an end_turn call does to the wake-up of the session's task (domain/turn-end.ts wakeEditOf): the task's
 * schedule holds at most one wake-up, and the call's next.when sets it — the time, the reason the session reads when
 * it fires, and this session as the one that set it, so the cockpit continues it then (the four-line order, line c).
 * It replaces a wake-up the task had and never touches a repeating time.
 *
 * A turn that ends without a time clears the wake-up only when this session set it; a hand-over to the owner clears
 * it whoever set it, so a review is not followed by a run nobody asked for. A session without a task has nothing to
 * set a wake-up on, and nothing fires on a closed task: there the time is refused, the rest of the call stands.
 *
 * The answer also says whether the task has a next run once the call is applied: a task that has one needs no time
 * from the agent (domain/turn-end.ts missingOf).
 */

export interface TurnWakeDeps {
  /** The session's task (the ledger's) and the brain of its space, with the space's agent; null: the cockpit does not know the session. */
  where(sessionId: string): { taskId: string | null; brain: Pick<EmlApi, 'get' | 'post'> | null; agent: string | null } | null
  /**
   * The task still has jobs of before brain schema 24 that are moving onto it (application/job-migration.ts): the
   * migration replaces its schedule with what they say, so nothing is written to it until they have moved.
   */
  moving?(taskId: string): boolean
  /** The user's time zone now: a call's when is read in it. */
  zone(): string
  now?: () => number
  /** The task's schedule changed: whatever shows it is built again. */
  changed?(): void
  log(line: string): void
}

export interface WakeSettled {
  /** Why the wake-up could not be set, or null; the rest of the call is recorded. */
  problem: string | null
  /** What helps then (domain/turn-end.ts CheckFix). */
  fix?: CheckFix
  /** The task's wake-up as saved: the zone the when was read in and the instant; null when none was set. */
  saved: CheckTime | null
  /** The task has a next run from its schedule now. */
  nextRun: boolean
}

export interface TurnWake {
  /** Brings the task's wake-up in line with the session's call. `why`: what the session reads when it fires. Never throws. */
  settle(sessionId: string, wanted: { edit: WakeEdit; why: string }): Promise<WakeSettled>
}

const OPEN = new Set(['planned', 'active'])

export const NO_TASK = 'this session works on no task, and a wake-up is set on a task'
export const TASK_CLOSED = 'the session\'s task is closed, and nothing fires on a closed task'

/** The task's schedule after a turn's end: the wake-up set (`at`: the instant), or cleared by the rule of `whose`. */
export function scheduleAfterTurn(
  schedule: ScheduleFields | null, edit: WakeEdit, by: { sessionId: string; at?: string; why: string; zone: string },
): ScheduleFields | null {
  if (edit.kind === 'set') return setWake(schedule, { at: by.at ?? edit.when, why: by.why, bySession: by.sessionId, timeZone: by.zone })
  return clearWake(schedule, edit.whose === 'own' ? { onlyBySession: by.sessionId } : {})
}

class Refused extends Error {
  constructor(message: string, readonly fix: CheckFix) { super(message) }
}

export function createTurnWake(deps: TurnWakeDeps): TurnWake {
  const now = () => deps.now?.() ?? Date.now()

  const settle = async (sessionId: string, wanted: { edit: WakeEdit; why: string }): Promise<WakeSettled> => {
    const { edit } = wanted
    const where = deps.where(sessionId)
    if (!where) throw new Refused('the cockpit does not know this session', 'none')
    if (!where.taskId) throw new Refused(NO_TASK, 'none')
    if (!where.brain) throw new Refused('the space of the session\'s task has no brain to write to', 'again')
    if (deps.moving?.(where.taskId)) throw new Refused('the task\'s jobs from before are still moving onto it; in a minute it can be set', 'again')
    const zone = deps.zone()
    let at: string | undefined
    if (edit.kind === 'set') {
      const time = parseAt(edit.when, zone)
      if (time === null) throw new Refused(`"${edit.when}" is not a time`, 'time')
      if (time - now() > JOB_LIMITS.maxAheadMs) throw new Refused('at most a year ahead', 'time')
      at = new Date(time).toISOString()
    }
    let open = true
    const written = await editTaskSchedule(where.brain, where.taskId, (schedule, task) => {
      open = OPEN.has(task.status)
      if (!open) {
        if (edit.kind === 'set') throw new Refused(TASK_CLOSED, 'none')
        return schedule
      }
      return scheduleAfterTurn(schedule, edit, { sessionId, at, why: wanted.why, zone })
    }, { agent: where.agent })
    if (written.changed) {
      deps.changed?.()
      deps.log(`[wake] ${sessionId.slice(0, 8)} task ${where.taskId.slice(0, 8)}: wake-up ${edit.kind === 'set' ? `set for ${edit.when} (${zone}) = ${at}` : 'cleared'}`)
    }
    const saved = edit.kind === 'set' && written.schedule?.at ? { at: Date.parse(written.schedule.at), zone } : null
    return { problem: null, saved, nextRun: open && nextRunOfSchedule(written.schedule, now()) !== null }
  }

  return {
    async settle(sessionId, wanted) {
      try {
        return await settle(sessionId, wanted)
      } catch (err) {
        const set = wanted.edit.kind === 'set'
        // A session without a task that names no time has nothing to clear: not worth a line.
        if (set || !(err instanceof Refused)) deps.log(`[wake] ${sessionId.slice(0, 8)} wake-up not ${set ? 'set' : 'cleared'}: ${(err as Error).message}`)
        if (!set) return { problem: null, saved: null, nextRun: false }
        return err instanceof Refused
          ? { problem: err.message, fix: err.fix, saved: null, nextRun: false }
          : { problem: `the task's schedule could not be written (${(err as Error).message})`, fix: 'again', saved: null, nextRun: false }
      }
    },
  }
}
