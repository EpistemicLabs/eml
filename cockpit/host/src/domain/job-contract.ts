import { isHeld, type Job, type ReplyChannel, type ReplyMode } from './job.js'

/**
 * Contract v1 between the cockpit and the channel bridge: the bridge owns
 * channel connections, messages and drafts; the cockpit owns jobs and decides
 * which session a wake reaches. The bridge mirrors these types rather than
 * importing them; both sides test against tests/fixtures/job-contract.v1.json.
 *
 *   GET  /v1/jobs?space=<brain id>&channel=mail   → JobRouteV1[]
 *        the space's records (one per task, domain/job.ts) with a trigger on that channel, of tasks that are
 *        open (a closed task's record stops listening, application/job-runner.ts); a paused one is listed
 *        (paused: true) so its mail still routes to it and waits
 *   POST /v1/jobs/<jobId>/wake  WakeRequestV1     → WakeResponseV1
 *        delivered: a session of the task has it, by the four-line order (domain/firing-order.ts): a working
 *        one gets it with its next turn, one that waits on an answer continues, else a new one starts;
 *        retry: no room, a busy session, a paused schedule, a record waiting for the user's OK, or the
 *        cockpit is down — try again later; a message is never skipped;
 *        refused: no such record, or its task is closed or gone.
 *        The same idempotencyKey within 7 days answers delivered without a second wake.
 *
 * Every request carries `Authorization: Bearer <token>`, the token of one space
 * (<home>/job-tokens/<brain id>, owner-only), and reaches only that space's jobs.
 */

export type MailMatchV1 = { kind: 'address'; address: string } | { kind: 'domain'; domain: string }

export interface JobRouteV1 {
  jobId: string
  /** The brain id of the job's space. */
  space: string
  /** For mail, MailMatchV1[]; other channels pass their trigger's match through. */
  matches: unknown[]
  reply: Partial<Record<ReplyChannel, ReplyMode>>
  /** Paused, or waiting for the user's OK: route to it as usual; its wakes answer retry until it runs again. */
  paused: boolean
}

export interface WakeRequestV1 {
  /** What arrived, in counts only, never message content ("2 new mails from acme.com"). */
  text: string
  idempotencyKey: string
  /** The channel it came from; by default the job's first channel trigger. */
  channel?: ReplyChannel
}

export type WakeOutcome = 'delivered' | 'retry' | 'refused'

export interface WakeResponseV1 {
  outcome: WakeOutcome
}

export const CHANNELS: readonly ReplyChannel[] = ['mail', 'slack', 'whatsapp']

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i

/** The valid mail matches of a trigger; anything else is left out. */
export function mailMatches(match: unknown[]): MailMatchV1[] {
  return match.flatMap((item): MailMatchV1[] => {
    const m = item as Record<string, unknown>
    if (m?.kind === 'address' && typeof m.address === 'string' && ADDRESS.test(m.address)) return [{ kind: 'address', address: m.address.toLowerCase() }]
    if (m?.kind === 'domain' && typeof m.domain === 'string' && DOMAIN.test(m.domain)) return [{ kind: 'domain', domain: m.domain.toLowerCase() }]
    return []
  })
}

/**
 * The task's record as the bridge routes it on a channel (`jobId` is the record's id: the task's); null when it does
 * not listen there. `paused`: the record holds still — it waits for the user's OK, the cockpit paused it after
 * failures, or the task's schedule is paused (`held`, application/job-runner.ts; without it only what the record
 * itself says). Its mail still routes to it and waits; its wakes answer retry.
 */
export function routeOf(job: Job, space: string, channel: ReplyChannel, held: boolean = isHeld(job)): JobRouteV1 | null {
  const triggers = job.triggers.filter((t) => t.type === channel)
  if (triggers.length === 0) return null
  const raw = triggers.flatMap((t) => ('match' in t && Array.isArray(t.match) ? t.match : []))
  const matches = channel === 'mail' ? mailMatches(raw) : raw
  // Draft until the user says otherwise: nothing goes out unseen by default.
  return { jobId: job.id, space, matches, reply: { [channel]: job.reply[channel] ?? 'draft' }, paused: held }
}
