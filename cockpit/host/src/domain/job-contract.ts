import type { Job, ReplyChannel, ReplyMode } from './job.js'

/**
 * Contract v1 between the cockpit and the channel bridge: the bridge owns
 * channel connections, messages and drafts; the cockpit owns jobs and decides
 * which session a wake reaches. The bridge mirrors these types rather than
 * importing them; both sides test against tests/fixtures/job-contract.v1.json.
 *
 *   GET  /v1/jobs?space=<brain id>&channel=mail   → JobRouteV1[]
 *        the space's open jobs (not paused, not ended) with a trigger on that channel
 *   POST /v1/jobs/<jobId>/wake  WakeRequestV1     → WakeResponseV1
 *        delivered: the job's session has it (a running one gets it with its next turn);
 *        retry: no room, a busy session, or the cockpit is down — try again later;
 *        refused: no such job, it ended, or its session is gone.
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

/** The job as the bridge routes it on a channel; null when it does not listen there or is not open. */
export function routeOf(job: Job, space: string, channel: ReplyChannel): JobRouteV1 | null {
  if (job.paused || job.endedAt) return null
  const triggers = job.triggers.filter((t) => t.type === channel)
  if (triggers.length === 0) return null
  const raw = triggers.flatMap((t) => ('match' in t && Array.isArray(t.match) ? t.match : []))
  const matches = channel === 'mail' ? mailMatches(raw) : raw
  // Draft until the user says otherwise: nothing goes out unseen by default.
  return { jobId: job.id, space, matches, reply: { [channel]: job.reply[channel] ?? 'draft' } }
}
