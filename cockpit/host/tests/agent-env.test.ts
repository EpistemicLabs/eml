import { describe, it, expect } from 'vitest'
import { baseAgentEnv } from '../src/pty-bridge.js'
import { platformFor } from '../src/infrastructure/platform/index.js'

const macos = platformFor('darwin')
const windows = platformFor('win32')

describe('baseAgentEnv', () => {
  it('gives a session without any locale a UTF-8 LANG', () => {
    const env = baseAgentEnv({ PATH: '/usr/bin', HOME: '/Users/x' }, macos)
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.PATH).toBe('/usr/bin')
    expect(baseAgentEnv({}, platformFor('linux')).LANG).toBe('C.UTF-8')
  })

  it("keeps the user's own locale", () => {
    expect(baseAgentEnv({ LANG: 'de_DE.UTF-8' }, macos).LANG).toBe('de_DE.UTF-8')
    expect(baseAgentEnv({ LC_ALL: 'de_DE.UTF-8' }, macos)).toEqual({ LC_ALL: 'de_DE.UTF-8' })
    expect(baseAgentEnv({ LC_CTYPE: 'UTF-8' }, macos)).toEqual({ LC_CTYPE: 'UTF-8' })
  })

  it('passes only allowlisted variables', () => {
    const env = baseAgentEnv({ LANG: 'C.UTF-8', CLAUDE_CODE_CHILD_SESSION: '1', ANTHROPIC_API_KEY: 'x', SystemRoot: 'C:\\Windows' }, macos)
    expect(env).toEqual({ LANG: 'C.UTF-8' })
  })

  it('on Windows passes what Windows programs need, and no LANG of its own', () => {
    const env = baseAgentEnv({ Path: 'C:\\Windows', PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\x', APPDATA: 'C:\\Users\\x\\AppData\\Roaming', ANTHROPIC_API_KEY: 'x' }, windows)
    expect(env).toEqual({ PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\x', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' })
  })
})
