import { waitKind, type WaitingOn } from './task-turn.js'

/**
 * The Inbox holds what waits for the viewer to answer or look at: a question or a go an agent
 * asked for, and a result to review.
 * Items are derived, never stored; an item clears itself when its wait clears. A snooze hides one
 * item until a time and does not change the task's turn. A snooze is keyed by the task and the
 * moment its wait began, so a newer question on the same task shows again.
 */

export type InboxKind = 'question' | 'review'

export interface InboxTask {
  id: string
  space: string
  title: string
  waitingOn?: WaitingOn
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
  for (const t of tasks) {
    const w = t.waitingOn
    if (!w || w.who !== viewer) continue
    const kind = waitKind(w)
    if (kind === 'stopped' || kind === 'outside') continue
    const since = w.since ?? ''
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
  const until = new Map(snoozes.filter((s) => Date.parse(s.until) > now).map((s) => [s.key, s.until]))
  return {
    live: items.filter((i) => !until.has(i.key)),
    snoozed: items.filter((i) => until.has(i.key)).map((i) => ({ ...i, until: until.get(i.key)! })),
  }
}
