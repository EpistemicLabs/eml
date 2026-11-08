import { z } from 'zod'
import type { Channel } from '../../domain/address'
import type { JobRoute, MailMatch, ReplyMode } from '../../domain/routing'
import type { Cockpit, WakeOutcome, WakeRequest } from '../../ports/cockpit'
import type { DirectoryUnavailable, JobDirectory, RouteAnswer, RoutesAnswer } from '../../ports/job-directory'

/**
 * The cockpit's /v1 job routes, read tolerantly: unknown fields are dropped, a match of a kind the
 * bridge does not know is left out, a reply mode it does not know counts as draft, and a route it
 * cannot read is skipped. A newer cockpit never stops the bridge's sync.
 */
const routeSchema = z.object({
  jobId: z.string(),
  space: z.string(),
  matches: z.array(z.unknown()),
  reply: z.record(z.string(), z.unknown()),
})
const matchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('address'), address: z.string() }),
  z.object({ kind: z.literal('domain'), domain: z.string() }),
])
const replyModeSchema = z.enum(['send', 'draft'])
const wakeAnswerSchema = z.object({ outcome: z.enum(['delivered', 'retry', 'refused']) })

const TIMEOUT_MS = 10_000

export interface CockpitHttpOptions {
  url: string
  /** One token per space; the cockpit answers for a space only with its token. */
  spaces: { space: string; token: string }[]
}

/** The cockpit's job routes and wake endpoint over loopback HTTP. */
export class CockpitHttpClient implements JobDirectory, Cockpit {
  constructor(private readonly options: CockpitHttpOptions) {}

  async routesInSpace(space: string, channel: Channel): Promise<RoutesAnswer> {
    const token = this.tokenFor(space)
    if (!token) return unavailable('no_token')
    let response: Response
    try {
      response = await fetch(`${this.options.url}/v1/jobs?${new URLSearchParams({ space, channel })}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      return unavailable('cockpit_unreachable')
    }
    if (!response.ok) return unavailable('bad_status')
    const body: unknown = await response.json().catch(() => null)
    if (!Array.isArray(body)) return unavailable('bad_answer')
    return { kind: 'routes', routes: body.flatMap((entry) => toJobRoute(entry, channel)) }
  }

  async route(jobId: string): Promise<RouteAnswer> {
    for (const { space } of this.options.spaces) {
      const answer = await this.routesInSpace(space, 'mail')
      if (answer.kind === 'unavailable') return answer
      const found = answer.routes.find((route) => route.jobId === jobId)
      if (found) return { kind: 'route', route: found }
    }
    return { kind: 'route', route: null }
  }

  /**
   * A cockpit that is away, busy or answers unreadably is a retry, so no wake is lost to a restart.
   * A request it rejects (an unknown job, a missing or wrong token) is refused: trying again cannot help.
   */
  async wakeJob(request: WakeRequest): Promise<WakeOutcome> {
    const token = this.tokenFor(request.space)
    if (!token) return 'refused'
    let response: Response
    try {
      response = await fetch(`${this.options.url}/v1/jobs/${encodeURIComponent(request.jobId)}/wake`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: request.text, idempotencyKey: request.idempotencyKey }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      return 'retry'
    }
    if (response.status === 408 || response.status === 429) return 'retry'
    if (response.status >= 400 && response.status < 500) return 'refused'
    if (!response.ok) return 'retry'
    const answer = wakeAnswerSchema.safeParse(await response.json().catch(() => null))
    return answer.success ? answer.data.outcome : 'retry'
  }

  private tokenFor(space: string): string | null {
    return this.options.spaces.find((entry) => entry.space === space)?.token ?? null
  }
}

function unavailable(reason: DirectoryUnavailable['reason']): DirectoryUnavailable {
  return { kind: 'unavailable', reason, retryable: true }
}

function toJobRoute(entry: unknown, channel: Channel): JobRoute[] {
  const parsed = routeSchema.safeParse(entry)
  if (!parsed.success) return []
  const matches: MailMatch[] = parsed.data.matches.flatMap((match) => {
    const known = matchSchema.safeParse(match)
    return known.success ? [known.data] : []
  })
  const reply: Partial<Record<Channel, ReplyMode>> = {}
  if (channel in parsed.data.reply) {
    const mode = replyModeSchema.safeParse(parsed.data.reply[channel])
    reply[channel] = mode.success ? mode.data : 'draft'
  }
  return [{ jobId: parsed.data.jobId, space: parsed.data.space, matches, reply }]
}
