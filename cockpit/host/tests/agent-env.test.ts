import { describe, it, expect } from 'vitest'
import { baseAgentEnv } from '../src/pty-bridge.js'

describe('baseAgentEnv', () => {
  it('gives a session without any locale a UTF-8 LANG', () => {
    const env = baseAgentEnv({ PATH: '/usr/bin', HOME: '/Users/x' })
    expect(env.LANG).toMatch(/UTF-8$/)
    expect(env.PATH).toBe('/usr/bin')
  })

  it("keeps the user's own locale", () => {
    expect(baseAgentEnv({ LANG: 'de_DE.UTF-8' }).LANG).toBe('de_DE.UTF-8')
    expect(baseAgentEnv({ LC_ALL: 'de_DE.UTF-8' })).toEqual({ LC_ALL: 'de_DE.UTF-8' })
    expect(baseAgentEnv({ LC_CTYPE: 'UTF-8' })).toEqual({ LC_CTYPE: 'UTF-8' })
  })

  it('passes only allowlisted variables', () => {
    const env = baseAgentEnv({ LANG: 'C.UTF-8', CLAUDE_CODE_CHILD_SESSION: '1', ANTHROPIC_API_KEY: 'x' })
    expect(env).toEqual({ LANG: 'C.UTF-8' })
  })
})
