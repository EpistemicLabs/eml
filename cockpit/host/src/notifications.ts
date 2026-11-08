import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { NOTIFICATIONS_FILE } from './paths.js'

/**
 * What the cockpit tells its user without a session to show it in: a job's run
 * that needs them, a run that failed, a job that paused itself. Kept in
 * <home>/notifications.json (the last 200), so they wait for the next time a
 * tab opens. The page shows them under the bell (GET /api/notifications).
 *
 * Everything that tells the user goes through a Notifier: the feed is the
 * first; a push to the phone becomes a second one next to it.
 */

export type NotificationKind = 'review' | 'question' | 'failed' | 'done' | 'missed' | 'paused'

export interface CockpitNotification {
  id: string
  at: string
  kind: NotificationKind
  /** One line: the job's name. */
  title: string
  /** What happened, as the user reads it. */
  body: string
  jobId: string | null
  /** The session that has the result, if any. */
  sessionId: string | null
  /** The brain space it belongs to; null = main. */
  spaceId: string | null
  read: boolean
}

export type NotificationInput = Omit<CockpitNotification, 'id' | 'at' | 'read'>

export interface Notifier {
  notify(input: NotificationInput): void
}

const KEEP = 200

export class NotificationFeed extends EventEmitter implements Notifier {
  private items: CockpitNotification[]

  constructor(private file = NOTIFICATIONS_FILE) {
    super()
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
      this.items = Array.isArray(parsed) ? parsed as CockpitNotification[] : []
    } catch {
      this.items = []
    }
  }

  notify(input: NotificationInput): void {
    const item: CockpitNotification = { ...input, id: randomUUID(), at: new Date().toISOString(), read: false }
    this.items = [item, ...this.items].slice(0, KEEP)
    this.persist()
    this.emit('notification', item)
  }

  /** Newest first. */
  list(): CockpitNotification[] {
    return this.items
  }

  unread(): number {
    return this.items.filter((item) => !item.read).length
  }

  /** Mark these read, or all when no ids are given. */
  markRead(ids?: string[]): void {
    const only = ids ? new Set(ids) : null
    let changed = false
    for (const item of this.items) {
      if (!item.read && (!only || only.has(item.id))) {
        item.read = true
        changed = true
      }
    }
    if (changed) this.persist()
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (err) {
      process.stderr.write(`[notifications] persist failed: ${(err as Error).message}\n`)
    }
  }
}

/** Several notifiers as one: the feed now, a push channel later. */
export function allOf(...notifiers: Notifier[]): Notifier {
  return { notify: (input) => { for (const notifier of notifiers) notifier.notify(input) } }
}
