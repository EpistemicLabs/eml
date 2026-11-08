import type { AgentProvider, LaunchRequest } from '../domain/agent-provider.js'
import type { Job } from '../domain/job.js'
import { channelJobProfile, type GrantableTool, type McpServerSpec } from '../domain/tool-profile.js'

/** A job that answers messages on a channel (mail, later Slack and WhatsApp), not only a schedule. */
export function isChannelJob(job: Pick<Job, 'triggers'>): boolean {
  return job.triggers.some((trigger) => trigger.type === 'mail' || trigger.type === 'slack' || trigger.type === 'whatsapp')
}

/** What a launch needs to know of the channel job a session works for. */
export interface ChannelJobFacts {
  jobId: string
  /** Marked by the user: its session gets the limited profile. */
  limited: boolean
  /** Tools the user lifted for now. */
  granted: GrantableTool[]
}

/**
 * A channel job's facts for its launches. Until the job model marks jobs limited, every channel job
 * is; grants come with the model too.
 */
export function channelJobFacts(job: Pick<Job, 'id' | 'triggers'>): ChannelJobFacts {
  return { jobId: job.id, limited: true, granted: [] }
}

export interface ChannelToolsDeps {
  /** The channel job a session works for, or null: from the ledger, so it holds after a resume too. */
  channelJobOf: (sessionId: string) => ChannelJobFacts | null
  /** The bridge's MCP server for a job, built now, with the paths of this install. */
  bridgeServer: (jobId: string) => Omit<McpServerSpec, 'type'>
}

/**
 * The provider, with every launch of a channel job's session given the bridge's tools, and limited
 * to the job's profile when the user marked the job limited. It is worked out at each launch, not
 * stored, so a resumed session gets the paths and grants of now.
 */
export function withChannelTools(provider: AgentProvider, deps: ChannelToolsDeps): AgentProvider {
  const launch = (req: LaunchRequest) => {
    const job = deps.channelJobOf(req.sessionId)
    if (!job) return provider.launch(req)
    return provider.launch({
      ...req,
      toolProfile: job.limited ? channelJobProfile(req.toolProfile ?? null, job.granted) : req.toolProfile ?? null,
      extraMcpServers: { ...req.extraMcpServers, channel_bridge: { type: 'stdio', ...deps.bridgeServer(job.jobId) } },
    })
  }
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'launch') return launch
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
