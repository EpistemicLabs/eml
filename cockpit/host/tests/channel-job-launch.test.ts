import { describe, expect, it } from 'vitest'
import { withChannelTools } from '../src/application/channel-job-launch.js'
import type { AgentProvider, LaunchRequest, LaunchSpec } from '../src/domain/agent-provider.js'

function fakeProvider() {
  const launches: LaunchRequest[] = []
  const provider = {
    id: 'claude',
    label: 'Claude Code',
    describe: () => 'claude provider',
    launch(req: LaunchRequest): LaunchSpec {
      launches.push(req)
      return { bin: 'claude', args: [this.describe()], env: {}, keepRunning: false }
    },
  } as unknown as AgentProvider
  return { provider, launches }
}

const request = (sessionId: string): LaunchRequest => ({
  sessionId, address: sessionId, space: {} as LaunchRequest['space'], providerSessionId: null, resume: true,
  initialPrompt: null, unattended: true, toolProfile: { deniedTools: ['WebFetch'], mcpServers: null },
})

describe('withChannelTools', () => {
  const server = (jobId: string) => ({ command: 'node', args: ['/app/dist/channel-bridge-mcp.cjs'], env: { CHANNEL_BRIDGE_JOB_ID: jobId } })

  it('gives a channel job\'s session the bridge tools and its limits at every launch', () => {
    const { provider, launches } = fakeProvider()
    const wrapped = withChannelTools(provider, { channelJobOf: (id) => (id === 's-job' ? 'job-1' : null), bridgeServer: server })
    wrapped.launch(request('s-job'))
    expect(launches[0]?.toolProfile).toEqual({ deniedTools: ['WebFetch', 'Bash'], mcpServers: [] })
    expect(launches[0]?.extraMcpServers).toEqual({ channel_bridge: { type: 'stdio', ...server('job-1') } })
  })

  it('leaves every other session as it is', () => {
    const { provider, launches } = fakeProvider()
    const wrapped = withChannelTools(provider, { channelJobOf: () => null, bridgeServer: server })
    const req = request('s-other')
    wrapped.launch(req)
    expect(launches[0]).toBe(req)
  })

  it('is the same provider in every other respect', () => {
    const { provider } = fakeProvider()
    const wrapped = withChannelTools(provider, { channelJobOf: () => 'job-1', bridgeServer: server })
    expect(wrapped.id).toBe('claude')
    expect(wrapped.launch(request('s')).args).toEqual(['claude provider'])
  })
})
