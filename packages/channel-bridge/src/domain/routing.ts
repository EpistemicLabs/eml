import { domainOf, normalizeMailAddress } from './address'
import type { Channel } from './address'
import type { InboundMessage } from './inbound-message'

export type MailMatch = { kind: 'address'; address: string } | { kind: 'domain'; domain: string }

export type ReplyMode = 'send' | 'draft'

/** What the bridge needs to know of a job; the cockpit owns the job itself. */
export interface JobRoute {
  jobId: string
  space: string
  matches: MailMatch[]
  /** How the job may answer per channel; a channel without an entry is not attached. */
  reply: Partial<Record<Channel, ReplyMode>>
}

export type Routing =
  | { kind: 'job'; jobId: string; reason: 'thread' | 'address' | 'domain' }
  | { kind: 'inbox'; reason: 'no_match' | 'ambiguous' | 'sender_unverified' }
  | { kind: 'ignored'; reason: 'automated' }

export interface RoutingContext {
  /** The jobs of the space the message's account belongs to. */
  routes: JobRoute[]
  /** The job an earlier message of the same thread went to, if any. */
  threadOwner: string | null
}

/**
 * Where an incoming message goes. The most specific match wins: the job that owns the
 * thread, then an exact address, then the sender's domain. A domain match counts only for a
 * verified sender, since anyone can claim to write from a domain. Two jobs matching equally
 * leave the choice to a person, so the message goes to the inbox.
 */
export function routeMessage(message: InboundMessage, context: RoutingContext): Routing {
  if (message.automated) return { kind: 'ignored', reason: 'automated' }

  if (context.threadOwner && context.routes.some((route) => route.jobId === context.threadOwner)) {
    return { kind: 'job', jobId: context.threadOwner, reason: 'thread' }
  }

  const sender = normalizeMailAddress(message.from)
  const byAddress = context.routes.filter((route) => matchesAddress(route, sender))
  if (byAddress.length > 1) return { kind: 'inbox', reason: 'ambiguous' }
  const [addressRoute] = byAddress
  if (addressRoute) return { kind: 'job', jobId: addressRoute.jobId, reason: 'address' }

  const domain = domainOf(sender)
  const byDomain = domain ? context.routes.filter((route) => matchesDomain(route, domain)) : []
  if (byDomain.length === 0) return { kind: 'inbox', reason: 'no_match' }
  if (!message.senderVerified) return { kind: 'inbox', reason: 'sender_unverified' }
  if (byDomain.length > 1) return { kind: 'inbox', reason: 'ambiguous' }
  const [domainRoute] = byDomain
  return domainRoute ? { kind: 'job', jobId: domainRoute.jobId, reason: 'domain' } : { kind: 'inbox', reason: 'no_match' }
}

/** The address is one the job names, or at a domain it names. */
export function routeCovers(route: JobRoute, address: string): boolean {
  const normalized = normalizeMailAddress(address)
  const domain = domainOf(normalized)
  return matchesAddress(route, normalized) || (domain !== null && matchesDomain(route, domain))
}

function matchesAddress(route: JobRoute, address: string): boolean {
  return route.matches.some((match) => match.kind === 'address' && normalizeMailAddress(match.address) === address)
}

function matchesDomain(route: JobRoute, domain: string): boolean {
  return route.matches.some((match) => match.kind === 'domain' && normalizeMailAddress(match.domain) === domain)
}
