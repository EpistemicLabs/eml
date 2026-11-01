import { describe, expect, it } from 'vitest'
import { parseToolProfile } from '../src/domain/tool-profile.js'
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
