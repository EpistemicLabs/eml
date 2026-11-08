import { describe, expect, it } from 'vitest'
import { parseToolProfile, channelJobProfile } from '../src/domain/tool-profile.js'
import { limitMcpServers } from '../src/infrastructure/providers/claude/isolation.js'

describe('parseToolProfile', () => {
  it('no fields, no profile', () => {
    expect(parseToolProfile({})).toBeNull()
  })

  it('takes either field', () => {
    expect(parseToolProfile({ deniedTools: ['Bash'] })).toEqual({ deniedTools: ['Bash'], mcpServers: null })
    expect(parseToolProfile({ mcpServers: [] })).toEqual({ deniedTools: [], mcpServers: [] })
  })

  it('refuses what is not a list of names', () => {
    expect(parseToolProfile({ deniedTools: 'Bash' })).toBe('invalid')
    expect(parseToolProfile({ mcpServers: ['a b'] })).toBe('invalid')
    expect(parseToolProfile({ deniedTools: ['--dangerous flag'] })).toBe('invalid')
  })
})

describe('limitMcpServers', () => {
  const config = { mcpServers: { gmail: { url: 'g' }, messages: { url: 'm' }, eml_brain: { url: 'b' } } }

  it('keeps the listed servers and always the brain', () => {
    expect(Object.keys(limitMcpServers(config, ['messages']).mcpServers)).toEqual(['messages', 'eml_brain'])
    expect(Object.keys(limitMcpServers(config, []).mcpServers)).toEqual(['eml_brain'])
  })
})

describe('channelJobProfile', () => {
  const CLOSED = ['Bash', 'SendMessage', 'mcp__cockpit__schedule']

  it('keeps what the maker denied, closes the ways out and leaves only the brain from the space', () => {
    expect(channelJobProfile({ deniedTools: ['Write'], mcpServers: ['gmail'] }, [])).toEqual({ deniedTools: ['Write', ...CLOSED], mcpServers: [] })
    expect(channelJobProfile(null, [])).toEqual({ deniedTools: CLOSED, mcpServers: [] })
    expect(channelJobProfile({ deniedTools: ['Bash'], mcpServers: null }, []).deniedTools).toEqual(CLOSED)
  })

  it('leaves the web tools on, and lifts a tool the user granted for now', () => {
    expect(channelJobProfile(null, []).deniedTools).not.toContain('WebFetch')
    expect(channelJobProfile(null, ['SendMessage']).deniedTools).toEqual(['Bash', 'mcp__cockpit__schedule'])
  })

  it('never lifts what the maker could not use, even when granted', () => {
    expect(channelJobProfile({ deniedTools: ['SendMessage'], mcpServers: null }, ['SendMessage']).deniedTools).toContain('SendMessage')
  })
})

describe('limitMcpServers with extra servers', () => {
  it('keeps every server when nothing limits them, and adds the extra ones', () => {
    const config = { mcpServers: { gmail: { url: 'g' }, eml_brain: { url: 'b' } } }
    const extra = { channel_bridge: { type: 'stdio', command: 'node', args: [], env: {} } }
    expect(limitMcpServers(config, null, extra).mcpServers).toEqual({ ...config.mcpServers, ...extra })
  })

  it('adds them next to the listed ones and the brain', () => {
    const config = { mcpServers: { gmail: { url: 'g' }, eml_brain: { url: 'b' } } }
    const extra = { channel_bridge: { type: 'stdio', command: 'node', args: ['bridge-mcp.cjs'], env: { CHANNEL_BRIDGE_JOB_ID: 'job-1' } } }
    expect(limitMcpServers(config, [], extra).mcpServers).toEqual({ eml_brain: { url: 'b' }, ...extra })
  })
})
