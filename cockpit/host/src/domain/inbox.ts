import { waitKind } from './task-turn.js'
import { isParked, type Wait } from './task-waits.js'

/**
 * The Inbox holds what waits for the viewer to answer or look at: a question or a go an agent
 * asked for, and a result to review.
 * Items are derived, never stored; an item clears itself when its wait clears. A parked wait
 * (snoozed_until on the wait, brain schema 23) is listed as snoozed until its date, on every device.
 * A snooze from before parking lived in this cockpit's store, keyed by the task and the moment its
 * wait began; it is still read until the migration has moved it onto the wait.
 *
 * Every wait of a task on the viewer is an item of its own (brain schema 23): two sessions that
 * asked on one task are two items, each opening its session.
 */

export type InboxKind = 'question' | 'review'

export interface InboxTask {
  id: string
  space: string
  title: string
  /** The task's waits (domain/task-waits.ts waitsOf). */
  waits: Wait[]
}

export interface Snooze {
  key: string
  until: string
}

export interface InboxItem {
  key: string
  kind: InboxKind
  space: string
  title: string
  text: string
  since: string
  taskId?: string
  sessionId?: string
  /** Set on a snoozed item: when it shows again. */
  until?: string
}

export function itemKey(item: { taskId: string; since?: string }): string {
  return `task:${item.taskId}@${item.since ?? ''}`
}

export function inboxItems(tasks: InboxTask[], viewer: string, snoozes: Snooze[], now: number): { live: InboxItem[]; snoozed: InboxItem[] } {
  const items: InboxItem[] = []
  const parkedUntil = new Map<string, string>()
  for (const t of tasks) for (const w of t.waits) {
    if (w.who !== viewer) continue
    const kind = waitKind(w)
    if (kind === 'stopped' || kind === 'outside') continue
    const since = w.since ?? ''
    if (isParked(w, now)) parkedUntil.set(itemKey({ taskId: t.id, since }), w.snoozed_until!)
    items.push({
      key: itemKey({ taskId: t.id, since }),
      kind: kind === 'review' ? 'review' : 'question',
      space: t.space,
      title: t.title,
      text: w.why ?? '',
      since,
      taskId: t.id,
      ...(w.session_id ? { sessionId: w.session_id } : {}),
    })
  }
  items.sort((a, b) => b.since.localeCompare(a.since))
  const until = new Map([...snoozes.filter((s) => Date.parse(s.until) > now).map((s) => [s.key, s.until] as const), ...parkedUntil])
  return {
    live: items.filter((i) => !until.has(i.key)),
    snoozed: items.filter((i) => until.has(i.key)).map((i) => ({ ...i, until: until.get(i.key)! })),
  }
}
