import type { AgentProvider, LaunchRequest } from '../domain/agent-provider.js'
import type { Job } from '../domain/job.js'
import { channelJobProfile, type McpServerSpec } from '../domain/tool-profile.js'

/** A job that answers messages on a channel (mail, later Slack and WhatsApp), not only a schedule. */
export function isChannelJob(job: Pick<Job, 'triggers'>): boolean {
  return job.triggers.some((trigger) => trigger.type === 'mail' || trigger.type === 'slack' || trigger.type === 'whatsapp')
}

export interface ChannelToolsDeps {
  /** The channel job a session works for, or null: from the ledger, so it holds after a resume too. */
  channelJobOf: (sessionId: string) => string | null
  /** The bridge's MCP server for a job, built now, with the paths of this install. */
  bridgeServer: (jobId: string) => Omit<McpServerSpec, 'type'>
}

/**
 * The provider, with every launch of a channel job's session limited to the job's profile and given
 * the bridge's tools. It is worked out at each launch, not stored, so a resumed session gets the
 * paths of the cockpit that runs it now.
 */
export function withChannelTools(provider: AgentProvider, deps: ChannelToolsDeps): AgentProvider {
  const launch = (req: LaunchRequest) => {
    const jobId = deps.channelJobOf(req.sessionId)
    if (!jobId) return provider.launch(req)
    return provider.launch({
      ...req,
      toolProfile: channelJobProfile(req.toolProfile ?? null),
      extraMcpServers: { ...req.extraMcpServers, channel_bridge: { type: 'stdio', ...deps.bridgeServer(jobId) } },
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
