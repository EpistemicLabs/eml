import { describe, it, expect } from 'vitest'
import { brainMcpServer, hookCurlConfig, hookEntry, HOOK_TOKEN_HEADER } from '../src/infrastructure/providers/claude/isolation.js'

// Command lines are visible to every local user via ps, so tokens must reach
// child processes through the environment or an owner-only file instead.

const BRAIN_TOKEN = 'eml_testprefix_testsecret'
const HOOK_TOKEN = '0123456789abcdef0123456789abcdef'

describe('brain MCP server entry', () => {
  const entry = brainMcpServer('http://127.0.0.1:60000', BRAIN_TOKEN)

  it('keeps the brain token out of the arguments', () => {
    expect(entry.args.join(' ')).not.toContain(BRAIN_TOKEN)
    expect(entry.args).not.toContain('--token')
  })

  it('passes URL and token through the environment the mcp-server CLI reads', () => {
    expect(entry.env).toEqual({ EML_API_URL: 'http://127.0.0.1:60000', EML_API_TOKEN: BRAIN_TOKEN })
  })
})

describe('turn-state hook entry', () => {
  const command = hookEntry('http://127.0.0.1:4317/api/hook', '/home/me/claude-config/hook-curl.conf').hooks[0].command

  it('keeps the hook token out of the command line', () => {
    expect(command).not.toContain(HOOK_TOKEN)
    expect(command).not.toContain('?k=')
  })

  it('reads the token from the curl config file', () => {
    expect(command).toContain("-K '/home/me/claude-config/hook-curl.conf'")
  })

  it('names the cockpit session from the session env, expanded by the shell', () => {
    expect(command).toContain('-H "x-cockpit-session: $COCKPIT_SESSION_ID"')
  })

  it('quotes a config path with spaces', () => {
    const spaced = hookEntry('http://127.0.0.1:4317/api/hook', '/Users/Jane Doe/hook-curl.conf').hooks[0].command
    expect(spaced).toContain("-K '/Users/Jane Doe/hook-curl.conf'")
  })
})

describe('hook curl config', () => {
  it('sends the token as the hook header', () => {
    expect(hookCurlConfig(HOOK_TOKEN)).toContain(`header = "${HOOK_TOKEN_HEADER}: ${HOOK_TOKEN}"`)
  })
})
