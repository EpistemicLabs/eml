import type { Channel } from './address'
import { routeCovers } from './routing'
import type { JobRoute } from './routing'

export type SendDecision =
  | { kind: 'send' }
  | { kind: 'draft' }
  | { kind: 'refused'; reason: 'not_job_contact' | 'channel_not_attached'; retryable: false }

export interface SendRequestFacts {
  route: JobRoute
  channel: Channel
  recipient: string
  /** The recipient wrote to this job before. */
  knownToJob: boolean
}

/**
 * Whether a job's message goes out now, waits as a draft, or not at all. A job writes only to
 * its own contacts: addresses its matches cover, or people who wrote to it. This holds even
 * for a job that may send freely, so injected text cannot make it write to anyone else.
 */
export function decideSend(facts: SendRequestFacts): SendDecision {
  const mode = facts.route.reply[facts.channel]
  if (!mode) return { kind: 'refused', reason: 'channel_not_attached', retryable: false }
  if (!facts.knownToJob && !routeCovers(facts.route, facts.recipient)) {
    return { kind: 'refused', reason: 'not_job_contact', retryable: false }
  }
  return { kind: mode }
}
