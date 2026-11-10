import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brainMcpServer } from '../src/infrastructure/providers/claude/isolation.js'
import { claudeHook, codexHook, shellLine, turnHookCommand, writeTurnHookConfig } from '../src/infrastructure/providers/shared.js'
import { expectOwnerOnly } from './helpers/owner-only.js'

// Command lines are visible to every local user via ps, so tokens must reach
// child processes through the environment or an owner-only file instead.

const BRAIN_TOKEN = 'eml_testprefix_testsecret'
const HOOK_TOKEN = '0123456789abcdef0123456789abcdef'

describe('brain MCP server entry', () => {
  const MCP_TOKEN = 'f'.repeat(64)
  const entry = brainMcpServer('http://127.0.0.1:4318/mcp', MCP_TOKEN)

  it('is the host endpoint over HTTP, with no process, arguments or brain token', () => {
    expect(entry).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4318/mcp',
      headers: { 'x-cockpit-mcp-token': MCP_TOKEN, 'x-eml-session': '${COCKPIT_SESSION_ID}' },
    })
    expect(JSON.stringify(entry)).not.toContain(BRAIN_TOKEN)
  })
})

describe('turn-state hook', () => {
  const cmd = turnHookCommand('/home/me/claude-config/turn-hook.json')

  it('keeps the hook token out of the command line, in every rendering', () => {
    for (const hook of [claudeHook(cmd, 'darwin'), claudeHook(cmd, 'win32'), codexHook(cmd, 'linux'), codexHook(cmd, 'win32')]) {
      expect(JSON.stringify(hook)).not.toContain(HOOK_TOKEN)
    }
  })

  it('names only its config file, no shell syntax', () => {
    expect(cmd.args.at(-1)).toBe('/home/me/claude-config/turn-hook.json')
    expect(shellLine(cmd)).not.toMatch(/\$|\|\||>|curl/)
  })

  it('reads URL and token from an owner-only file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-turn-hook-config-'))
    try {
      const file = join(dir, 'turn-hook.json')
      writeTurnHookConfig(file, 'http://127.0.0.1:4317/api/hook', HOOK_TOKEN)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ url: 'http://127.0.0.1:4317/api/hook', token: HOOK_TOKEN })
      expectOwnerOnly(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
