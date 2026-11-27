import type { EmlApi } from '@engramprotocol/mcp-server'
import { formatInZone } from '../domain/schedule.js'
import { clearWake, sameInstant } from '../domain/task-schedule.js'
import { sameWaits, waitsBody, waitsOf, type Wait } from '../domain/task-waits.js'
import { editTaskSchedule } from './task-schedule-write.js'

/**
 * A person's wake-up fired (schedule.by names a person, decision asks-and-check-backs-are-separate): a reminder. In
 * one write to the task it
 *   - adds a do wait for them ({ who: by, kind: do, why: the wake-up's reason }): their Inbox shows it as their move;
 *   - takes the wake-up off the task (it is used up);
 *   - journals "Reminder fired for <who> (<time>): <why>".
 * A task whose wake-up is another one by now gets neither: that one fires on its own. The wait's id names the
 * wake-up, so firing the same reminder twice adds one wait.
 */

export interface Reminder {
  /** The wake-up's time (ISO). */
  at: string
  /** Who it is for: a person's handle. */
  who: string
  why: string | null
  /** The user's time zone, for the journal line. */
  zone: string
  /** Now (ISO): the wait's since. */
  now: string
}

/** The do wait a reminder puts on the task. */
export function reminderWait(r: Pick<Reminder, 'at' | 'who' | 'why' | 'now'>): Wait {
  return { id: `reminder:${r.at}`, who: r.who, kind: 'do', why: r.why?.trim() || 'Reminder', since: r.now }
}

export async function fireReminder(brain: Pick<EmlApi, 'get' | 'post'>, taskId: string, r: Reminder): Promise<void> {
  let ours = false
  await editTaskSchedule(brain, taskId, (schedule) => {
    ours = sameInstant(schedule?.at, r.at)
    return ours ? clearWake(schedule) : schedule
  }, {
    onlyWithChange: true,
    fieldsOf: (task) => {
      if (!ours) return {}
      const waits = waitsOf(task.properties ?? undefined)
      const wait = reminderWait(r)
      const after = waits.some((w) => w.id === wait.id) ? waits : [...waits, wait]
      return sameWaits(after, waits) ? {} : waitsBody(after)
    },
    text: (_before, _after, changed) => (changed ? `Reminder fired for ${r.who} (${formatInZone(Date.parse(r.at), r.zone)}, ${r.zone}): ${r.why?.trim().replace(/[.\s]+$/, '') || 'no reason given'}. It is in their Inbox as their move.` : null),
  })
}
