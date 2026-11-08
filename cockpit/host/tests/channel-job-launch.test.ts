import { describe, expect, it } from 'vitest'
import { channelJobFacts, withChannelTools } from '../src/application/channel-job-launch.js'
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
    const wrapped = withChannelTools(provider, {
      channelJobOf: (id) => (id === 's-job' ? { jobId: 'job-1', limited: true, granted: [] } : null), bridgeServer: server,
    })
    wrapped.launch(request('s-job'))
    expect(launches[0]?.toolProfile).toEqual({ deniedTools: ['WebFetch', 'Bash', 'SendMessage', 'mcp__cockpit__schedule'], mcpServers: [] })
    expect(launches[0]?.extraMcpServers).toEqual({ channel_bridge: { type: 'stdio', ...server('job-1') } })
  })

  it('gives a job that is not limited its maker\'s tools and the bridge tools', () => {
    const { provider, launches } = fakeProvider()
    const wrapped = withChannelTools(provider, { channelJobOf: () => ({ jobId: 'job-1', limited: false, granted: [] }), bridgeServer: server })
    wrapped.launch(request('s-job'))
    expect(launches[0]?.toolProfile).toEqual({ deniedTools: ['WebFetch'], mcpServers: null })
    expect(launches[0]?.extraMcpServers).toEqual({ channel_bridge: { type: 'stdio', ...server('job-1') } })
  })

  it('lifts a granted tool for a limited job', () => {
    const { provider, launches } = fakeProvider()
    const wrapped = withChannelTools(provider, { channelJobOf: () => ({ jobId: 'job-1', limited: true, granted: ['SendMessage'] }), bridgeServer: server })
    wrapped.launch(request('s-job'))
    expect(launches[0]?.toolProfile?.deniedTools).not.toContain('SendMessage')
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
    const wrapped = withChannelTools(provider, { channelJobOf: () => ({ jobId: 'job-1', limited: true, granted: [] }), bridgeServer: server })
    expect(wrapped.id).toBe('claude')
    expect(wrapped.launch(request('s')).args).toEqual(['claude provider'])
  })
})

describe('channelJobFacts', () => {
  const now = Date.parse('2026-11-08T10:00:00.000Z')
  const job = { id: 'job-1', triggers: [{ type: 'mail' as const, match: [] }] }

  it('counts a channel job as limited unless the user took the limits off', () => {
    expect(channelJobFacts(job, now).limited).toBe(true)
    expect(channelJobFacts({ ...job, limited: true }, now).limited).toBe(true)
    expect(channelJobFacts({ ...job, limited: false }, now).limited).toBe(false)
  })

  it('lists only the grants that still run', () => {
    const grants = [
      { tool: 'SendMessage' as const, until: '2026-11-08T11:00:00.000Z', reason: null },
      { tool: 'chrome' as const, until: '2026-11-08T09:00:00.000Z', reason: null },
    ]
    expect(channelJobFacts({ ...job, grants }, now).granted).toEqual(['SendMessage'])
  })
})
