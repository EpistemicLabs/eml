import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, SessionSpace } from '../src/domain/agent-provider.js'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-claude-provider-test-'))
process.env.EML_COCKPIT_HOME = home
const configDir = join(home, 'claude-config')

// The space a session runs in; its files are written by brain-space.ts, not the provider.
const space: SessionSpace = {
  id: 'space-1', url: 'http://127.0.0.1:60000', token: 'eml_testprefix_testsecret',
  files: {
    mcpConfig: join(configDir, 'spaces', 'space-1', 'mcp.json'),
    settings: join(configDir, 'spaces', 'space-1', 'settings.json'),
    emlConfig: join(home, 'eml', 'spaces', 'space-1', 'config'),
  },
}

describe('Claude Code provider', () => {
  let provider: AgentProvider

  beforeAll(async () => {
    const { createClaudeProvider } = await import('../src/infrastructure/providers/claude/index.js')
    provider = createClaudeProvider()
    provider.prepare({ hookUrl: 'http://127.0.0.1:60001/api/hook', hookToken: '0123456789abcdef', writableDirs: [] })
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('launches a new session under the cockpit session id, with its space\'s files, in the isolated config', () => {
    const launch = provider.launch({ sessionId: 'abc-1', space, providerSessionId: null, resume: false, initialPrompt: null, unattended: false })
    expect(launch.args).toEqual([
      '--mcp-config', space.files.mcpConfig,
      '--settings', space.files.settings, '--setting-sources', 'user,project,local',
      '--permission-mode', 'auto',
      '--session-id', 'abc-1',
    ])
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(configDir)
    expect(launch.env.DISABLE_AUTOUPDATER).toBe('1')
    expect(launch.env.PATH.split(':')[0]).toBe(join(home, 'claude', 'bin'))
    expect(launch.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
    expect(launch.env.CLAUDE_CODE_NO_FLICKER).toBe('1')
    // The brain reaches Claude Code through the space's mcp.json, not the session env.
    expect(Object.values(launch.env).join(' ')).not.toContain(space.token)
  })

  it('resumes by id and hands an initial prompt over as the last argument', () => {
    const base = { space, providerSessionId: null, initialPrompt: null, unattended: false }
    expect(provider.launch({ ...base, sessionId: 'abc-1', resume: true }).args.slice(-2)).toEqual(['--resume', 'abc-1'])
    expect(provider.launch({ ...base, sessionId: 'abc-2', resume: false, initialPrompt: '/login', unattended: true }).args.slice(-3))
      .toEqual(['--session-id', 'abc-2', '/login'])
  })

  it('runs unattended sessions in auto whatever the user chose', () => {
    writeFileSync(join(home, 'agents.json'), JSON.stringify({ permissionMode: 'bypassPermissions' }))
    const mode = (unattended: boolean) => {
      const { args } = provider.launch({ sessionId: 'abc-3', space, providerSessionId: null, resume: false, initialPrompt: null, unattended })
      return args[args.indexOf('--permission-mode') + 1]
    }
    expect(mode(false)).toBe('bypassPermissions')
    expect(mode(true)).toBe('auto')
  })

  it('leaves the renderer to Claude Code once the pinned input is switched off', () => {
    writeFileSync(join(home, 'agents.json'), JSON.stringify({ renderer: 'default' }))
    const launch = provider.launch({ sessionId: 'abc-5', space, providerSessionId: null, resume: false, initialPrompt: null, unattended: false })
    expect(launch.env).not.toHaveProperty('CLAUDE_CODE_NO_FLICKER')
  })

  it('can resume only once Claude Code wrote a transcript', () => {
    const session = { sessionId: 'abc-4', providerSessionId: null, projectPath: null }
    expect(provider.canResume(session)).toBe(false)
    mkdirSync(join(configDir, 'projects', '-some-project'), { recursive: true })
    writeFileSync(join(configDir, 'projects', '-some-project', 'abc-4.jsonl'), '')
    expect(provider.canResume(session)).toBe(true)
  })

  it('tells a missing conversation apart from other early exits', () => {
    expect(provider.resumeNotFound('No conversation found with session ID: abc-1')).toBe(true)
    expect(provider.resumeNotFound('error: unknown option')).toBe(false)
  })

  it('maps hooks to turn signals', () => {
    const hook = (extra: Record<string, unknown>) => provider.turnSignal({ session_id: 's1', ...extra })
    expect(hook({ hook_event_name: 'UserPromptSubmit' })).toEqual({ kind: 'turn', providerSessionId: 's1', state: 'working' })
    expect(hook({ hook_event_name: 'Stop' })).toEqual({ kind: 'turn', providerSessionId: 's1', state: 'done' })
    expect(hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }))
      .toEqual({ kind: 'turn', providerSessionId: 's1', state: 'waiting' })
    expect(hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }))
      .toEqual({ kind: 'unclassified', label: 'idle_prompt' })
    expect(hook({ hook_event_name: 'SessionStart' })).toBeNull()
    expect(provider.turnSignal({ hook_event_name: 'Stop' })).toBeNull()
  })
})
