import { z } from 'zod'
import type { JobRoute } from '../../domain/routing'
import type { Cockpit, WakeOutcome, WakeRequest } from '../../ports/cockpit'
import type { JobDirectory } from '../../ports/job-directory'

/** The cockpit's /v1 job contract, as far as the bridge reads it. Unknown fields are dropped. */
const jobRouteSchema = z.object({
  jobId: z.string(),
  space: z.string(),
  matches: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('address'), address: z.string() }),
      z.object({ kind: z.literal('domain'), domain: z.string() }),
    ]),
  ),
  reply: z.object({ mail: z.enum(['send', 'draft']).optional() }),
})
const jobRoutesSchema = z.array(jobRouteSchema)
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

  /** Throws when the cockpit cannot answer: routing without the jobs would send every message to the inbox. */
  async routesInSpace(space: string): Promise<JobRoute[]> {
    const token = this.tokenFor(space)
    if (!token) throw new Error(`no token for space ${space}`)
    const query = new URLSearchParams({ space, channel: 'mail' })
    const response = await fetch(`${this.options.url}/v1/jobs?${query}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`job routes for space ${space}: status ${response.status}`)
    return jobRoutesSchema.parse(await response.json()).map(toJobRoute)
  }

  async route(jobId: string): Promise<JobRoute | null> {
    for (const { space } of this.options.spaces) {
      const found = (await this.routesInSpace(space)).find((route) => route.jobId === jobId)
      if (found) return found
    }
    return null
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

function toJobRoute(parsed: z.infer<typeof jobRouteSchema>): JobRoute {
  return {
    jobId: parsed.jobId,
    space: parsed.space,
    matches: parsed.matches,
    reply: parsed.reply.mail ? { mail: parsed.reply.mail } : {},
  }
}
