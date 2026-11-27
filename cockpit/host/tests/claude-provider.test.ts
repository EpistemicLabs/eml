import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { AgentProvider, SessionSpace } from '../src/domain/agent-provider.js'
import { platform } from '../src/infrastructure/platform/index.js'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-claude-provider-test-'))
process.env.EML_COCKPIT_HOME = home
const configDir = join(home, 'claude-config')

// The space a session runs in; its files are written by brain-space.ts, not the provider.
const space: SessionSpace = {
  id: 'space-1', mcpToken: 'f'.repeat(64),
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
    provider.prepare({ hookUrl: 'http://127.0.0.1:60001/api/hook', hookToken: '0123456789abcdef', mcpUrl: 'http://127.0.0.1:60001/mcp', cockpitMcpUrl: 'http://127.0.0.1:60001/mcp/cockpit', writableDirs: [] })
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('launches a new session under the cockpit session id, with its space\'s files, in the isolated config', () => {
    const launch = provider.launch({ sessionId: 'abc-1', address: 'eml-abc1', space, providerSessionId: null, resume: false, initialPrompt: null, unattended: false })
    expect(launch.args).toEqual([
      '--mcp-config', space.files.mcpConfig,
      '--settings', space.files.settings, '--setting-sources', 'user,project,local',
      '--permission-mode', 'auto',
      '--name', 'eml-abc1',
      '--session-id', 'abc-1',
    ])
    expect(launch.env.COCKPIT_SESSION_ADDRESS).toBe('eml-abc1')
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(configDir)
    expect(launch.env.DISABLE_AUTOUPDATER).toBe('1')
    // Windows has no file links: sessions run the binary through the current junction (managed-runtime.ts).
    expect(launch.env.PATH.split(delimiter)[0]).toBe(join(home, 'claude', platform.linksFiles ? 'bin' : 'current'))
    expect(launch.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
    expect(launch.env.CLAUDE_CODE_NO_FLICKER).toBe('1')
    // The brain reaches Claude Code through the space's mcp.json, not the session env.
    expect(Object.values(launch.env).join(' ')).not.toContain(space.token)
  })

  it('gives a limited session browser control only when it was lent for now', () => {
    mkdirSync(join(configDir, 'spaces', 'space-1'), { recursive: true })
    writeFileSync(space.files.mcpConfig, JSON.stringify({ mcpServers: { eml_brain: { type: 'http', url: 'http://127.0.0.1:60000/mcp' } } }))
    const limited = { sessionId: 'job-1', address: 'eml-job1', space, providerSessionId: null, resume: false, initialPrompt: null, unattended: true,
      toolProfile: { deniedTools: ['Bash'], mcpServers: [] } }
    const without = provider.launch(limited)
    expect(without.args).not.toContain('--chrome')
    expect(without.chrome).toBeUndefined()
    const lent = provider.launch({ ...limited, chrome: true })
    expect(lent.args).toContain('--chrome')
    expect(lent.chrome).toBe(true)
  })

  it('resumes by id and hands an initial prompt over as the last argument', () => {
    const base = { address: 'eml-abc', space, providerSessionId: null, initialPrompt: null, unattended: false }
    expect(provider.launch({ ...base, sessionId: 'abc-1', resume: true }).args.slice(-2)).toEqual(['--resume', 'abc-1'])
    expect(provider.launch({ ...base, sessionId: 'abc-2', resume: false, initialPrompt: '/login', unattended: true }).args.slice(-3))
      .toEqual(['--session-id', 'abc-2', '/login'])
  })

  it('runs unattended sessions in auto whatever the user chose', () => {
    writeFileSync(join(home, 'agents.json'), JSON.stringify({ permissionMode: 'bypassPermissions' }))
    const mode = (unattended: boolean) => {
      const { args } = provider.launch({ sessionId: 'abc-3', address: 'eml-abc3', space, providerSessionId: null, resume: false, initialPrompt: null, unattended })
      return args[args.indexOf('--permission-mode') + 1]
    }
    expect(mode(false)).toBe('bypassPermissions')
    expect(mode(true)).toBe('auto')
  })

  it('has no Remote Control and no renderer setting any more: stored keys change nothing', () => {
    writeFileSync(join(home, 'agents.json'), JSON.stringify({ remoteControl: true, renderer: 'default' }))
    const launch = provider.launch({ sessionId: 'abc-6', address: 'eml-abc6', space, providerSessionId: null, resume: false, initialPrompt: 'hello', unattended: false })
    expect(launch.args).not.toContain('--remote-control')
    expect(launch).not.toHaveProperty('keepRunning')
    expect(launch.env.CLAUDE_CODE_NO_FLICKER).toBe('1')
    writeFileSync(join(home, 'agents.json'), JSON.stringify({}))
  })

  it('in token mode runs workers in chat too, and the chat session\'s CLI gets the setup-token', async () => {
    const { claudeStartOptions } = await import('../src/infrastructure/providers/claude/sdk-runtime.js')
    const fakeToken = `sk-ant-oat01-${'x'.repeat(40)}`
    writeFileSync(join(home, 'claude-login'), `${fakeToken}\n`, { mode: 0o600 })
    writeFileSync(join(home, 'agents.json'), JSON.stringify({ loginMode: 'token' }))
    try {
      const launch = provider.launch({ sessionId: 'tok-1', address: 'eml-tok1', space, providerSessionId: null, resume: false, initialPrompt: null, unattended: false })
      expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(fakeToken)
      expect(claudeStartOptions({ env: launch.env, launch, space }).env.CLAUDE_CODE_OAUTH_TOKEN).toBe(fakeToken)
    } finally {
      rmSync(join(home, 'claude-login'), { force: true })
      writeFileSync(join(home, 'agents.json'), JSON.stringify({}))
    }
  })

  it('runs in the chat whatever an old chat view switch says, and has no settings of its own', () => {
    writeFileSync(join(home, 'agents.json'), JSON.stringify({ chatView: false }))
    expect(provider.capabilities.chat).toEqual({ supported: true })
    expect(provider.chatRuntime).toBeDefined()
    expect(provider.settings).toBeUndefined()
    writeFileSync(join(home, 'agents.json'), JSON.stringify({}))
  })

  it('can resume only once Claude Code wrote a transcript', () => {
    const session = { sessionId: 'abc-4', providerSessionId: null, projectPath: null, greeted: null }
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
    expect(hook({ hook_event_name: 'UserPromptSubmit' })).toEqual({ kind: 'turn', providerSessionId: 's1', state: 'working', prompt: true })
    expect(hook({ hook_event_name: 'Stop' })).toEqual({ kind: 'turn', providerSessionId: 's1', state: 'done' })
    expect(hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }))
      .toEqual({ kind: 'turn', providerSessionId: 's1', state: 'waiting' })
    expect(hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }))
      .toEqual({ kind: 'unclassified', label: 'idle_prompt' })
    expect(hook({ hook_event_name: 'SessionStart' })).toBeNull()
    expect(provider.turnSignal({ hook_event_name: 'Stop' })).toBeNull()
  })

  it('has the chat, the end_turn tool and messaging; its terminal sessions get no tools from the host', () => {
    expect(provider.capabilities).toEqual({
      chat: { supported: true }, endTurnTool: { supported: true }, messaging: { supported: true },
      terminalTools: { supported: false, reason: 'Claude Code sessions have the cockpit\'s tools built in in the chat; in the terminal fallback they have none.' },
      toolLimits: { supported: true },
    })
  })
})
