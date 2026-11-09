import { createHash } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { pushMessage, sessionNotice, type SessionFacts } from '../domain/push-notice.js'
import type { NotificationInput, Notifier } from '../notifications.js'
import type { PushDevice } from '../push-store.js'
import type { PushUrgency } from '../infrastructure/push/web-push.js'
import type { TurnEvent } from '../turn-state.js'

export interface PushNotifierDeps {
  devices(): PushDevice[]
  /** One encrypted message to one device; answers the push service's status. */
  send(device: PushDevice, payload: Buffer, options: { urgency: PushUrgency; topic: string }): Promise<number>
  /** The push service said the subscription is gone. */
  forget(endpoint: string): void
  log(line: string): void
  now(): number
}

/** sent: taken · gone: the device unsubscribed · refused: the push service turned the message down · failed: a retry may help. */
export type SendOutcome = 'sent' | 'gone' | 'refused' | 'failed'

/** The user has that session in front of them: a push would only repeat what they see. */
const WATCHING_MS = 60_000
/** A job's notice and its session's own state often say the same thing moments apart. */
const REPEAT_MS = 120_000
/** A cockpit in use reports every 30 seconds (the page decides it is in use: input within 10 minutes). */
const IN_USE_MS = 90_000
/** A cockpit in use that has no subscription of its own. */
const NO_DEVICE = ''

/**
 * Web push as the cockpit's Notifier: every notice goes to every subscribed
 * device, unless the user is looking at that session or was just told the
 * same about it. While the user works in the cockpit on a device, only that
 * device is told; the others (the phone) stay quiet. Sending never blocks or fails the caller; what went wrong is
 * logged with ids and outcomes only, never the text.
 */
export class PushNotifier implements Notifier {
  private seen = new Map<string, number>()
  private told = new Map<string, number>()
  private inUse = new Map<string, number>()

  constructor(private deps: PushNotifierDeps) {}

  /** Sessions the user has in front of them now (the page reports them while it is focused). */
  watching(sessionIds: string[]): void {
    const now = this.deps.now()
    for (const sessionId of sessionIds) this.seen.set(sessionId, now)
  }

  /** A cockpit in use on this device; null: on one that gets no pushes. */
  present(endpoint: string | null): void {
    this.inUse.set(endpoint ?? NO_DEVICE, this.deps.now())
  }

  notify(input: NotificationInput): void {
    void this.deliver(input).catch((err: unknown) => this.deps.log(`[push] delivery failed: ${(err as Error).message}`))
  }

  async deliver(input: NotificationInput): Promise<{ sent: number; gone: number; failed: number; refused: number }> {
    const now = this.deps.now()
    const result = { sent: 0, gone: 0, failed: 0, refused: 0 }
    if (input.sessionId && now - (this.seen.get(input.sessionId) ?? -Infinity) < WATCHING_MS) return result
    const repeat = `${input.sessionId ?? input.jobId ?? ''}:${input.kind}`
    if (now - (this.told.get(repeat) ?? -Infinity) < REPEAT_MS) return result
    this.told.set(repeat, now)
    for (const [key, at] of this.told) if (now - at >= REPEAT_MS) this.told.delete(key)

    const urgency: PushUrgency = input.kind === 'question' || input.kind === 'failed' || input.kind === 'paused' ? 'high' : 'normal'
    const inUse = new Set([...this.inUse].filter(([, at]) => now - at < IN_USE_MS).map(([endpoint]) => endpoint))
    const targets = inUse.size > 0 ? this.deps.devices().filter((device) => inUse.has(device.endpoint)) : this.deps.devices()
    await Promise.all(targets.map(async (device) => {
      const outcome = await this.sendOne(device, input, urgency)
      result[outcome] += 1
    }))
    this.deps.log(`[push] kind=${input.kind} session=${input.sessionId?.slice(0, 8) ?? '-'} job=${input.jobId?.slice(0, 8) ?? '-'} sent=${result.sent} gone=${result.gone} failed=${result.failed} refused=${result.refused}`)
    return result
  }

  /** "Send test notification" in Settings: to the device that asked, nothing else. */
  async test(endpoint: string): Promise<SendOutcome | 'unknown'> {
    const device = this.deps.devices().find((entry) => entry.endpoint === endpoint)
    if (!device) return 'unknown'
    const outcome = await this.sendOne(device, { kind: 'done', title: 'Test', body: 'Notifications from the cockpit reach this device.', jobId: null, sessionId: null, spaceId: null }, 'normal')
    this.deps.log(`[push] test device=${device.id.slice(0, 8)} outcome=${outcome}`)
    return outcome
  }

  private async sendOne(device: PushDevice, input: NotificationInput, urgency: PushUrgency): Promise<SendOutcome> {
    try {
      const message = pushMessage(input, device.origin)
      // A newer message about the same session replaces one the push service still holds for an offline device.
      const topic = createHash('sha256').update(message.notification.tag).digest('base64url').slice(0, 32)
      const status = await this.deps.send(device, Buffer.from(JSON.stringify(message)), { urgency, topic })
      if (status === 404 || status === 410) {
        this.deps.forget(device.endpoint)
        return 'gone'
      }
      if (status >= 200 && status < 300) return 'sent'
      this.deps.log(`[push] device=${device.id.slice(0, 8)} status=${status}`)
      // The push service turned the message itself down (its token, its size): sending it again changes nothing.
      return status >= 400 && status < 500 && status !== 429 ? 'refused' : 'failed'
    } catch (err) {
      this.deps.log(`[push] device=${device.id.slice(0, 8)} error=${(err as Error).name}`)
      return 'failed'
    }
  }
}

/** Hooks and the chat's own turn end arrive in either order; the state a moment later is the one to tell. */
const SETTLE_MS = 3_000

/**
 * Sessions tell the Notifier what the review section shows: Needs you, Check
 * this, a new result. Each turn change is looked at once it has settled, and
 * each state is told once (sessionNotice's key).
 */
export function notifySessions(deps: { turns: Pick<EventEmitter, 'on'>; facts(sessionId: string): SessionFacts | null; notifier: Notifier }): void {
  const timers = new Map<string, NodeJS.Timeout>()
  const lastKey = new Map<string, string>()
  deps.turns.on('turn', (event: TurnEvent) => {
    clearTimeout(timers.get(event.sessionId))
    if (event.state !== 'waiting' && event.state !== 'done') return
    const timer = setTimeout(() => {
      timers.delete(event.sessionId)
      const facts = deps.facts(event.sessionId)
      const notice = facts && sessionNotice(facts)
      if (!notice || lastKey.get(event.sessionId) === notice.key) return
      lastKey.set(event.sessionId, notice.key)
      deps.notifier.notify(notice.input)
    }, SETTLE_MS)
    timer.unref?.()
    timers.set(event.sessionId, timer)
  })
}
