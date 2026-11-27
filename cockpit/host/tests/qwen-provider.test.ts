import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, SessionSpace } from '../src/domain/agent-provider.js'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-qwen-provider-test-'))
process.env.EML_COCKPIT_HOME = home
const qwenHome = join(home, 'qwen-config')
const HOOK_TOKEN = '0123456789abcdef'
const MCP_TOKEN = 'f'.repeat(64)
const MCP_URL = 'http://127.0.0.1:60001/mcp'
const COCKPIT_MCP_URL = 'http://127.0.0.1:60001/mcp/cockpit'
const API_KEY = 'sk-test-0000'
const darwin = process.platform === 'darwin'

afterAll(() => rmSync(home, { recursive: true, force: true }))

// The space a session runs in; Qwen Code gets its MCP token through the session env, not a file of its own.
const space: SessionSpace = {
  id: 'space-1', mcpToken: MCP_TOKEN,
  files: {
    mcpConfig: join(home, 'claude-config', 'spaces', 'space-1', 'mcp.json'),
    settings: join(home, 'claude-config', 'spaces', 'space-1', 'settings.json'),
    emlConfig: join(home, 'eml', 'spaces', 'space-1', 'config'),
  },
}

const prepare = (provider: AgentProvider, hookToken = HOOK_TOKEN) => provider.prepare({
  hookUrl: 'http://127.0.0.1:60001/api/hook', hookToken, mcpUrl: MCP_URL, cockpitMcpUrl: COCKPIT_MCP_URL,
  writableDirs: [join(home, 'spawn-inbox'), join(home, 'tasks')],
})

describe('Qwen Code settings', () => {
  let provider: AgentProvider
  beforeAll(async () => {
    const { createQwenProvider } = await import('../src/infrastructure/providers/qwen/index.js')
    provider = createQwenProvider()
  })

  it('keeps the endpoint in agents.json and the key in its own owner-only file, never back to the UI', () => {
    expect(provider.settings?.read()).toEqual({ permissionMode: 'auto', baseUrl: '', model: '', apiKeySet: false, sandboxed: darwin })
    expect(provider.settings?.write({ baseUrl: ' https://openrouter.ai/api/v1 ', model: 'qwen/qwen3.8-27b', apiKey: API_KEY })).toBeNull()
    expect(provider.settings?.read()).toEqual({ permissionMode: 'auto', baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3.8-27b', apiKeySet: true, sandboxed: darwin })
    expect(JSON.stringify(provider.settings?.read())).not.toContain(API_KEY)
    expect(readFileSync(join(home, 'agents.json'), 'utf8')).not.toContain(API_KEY)
    const keyFile = join(home, 'qwen-api-key')
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(API_KEY)
    if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    // An empty key removes it: a local endpoint needs none.
    expect(provider.settings?.write({ apiKey: '' })).toBeNull()
    expect(existsSync(keyFile)).toBe(false)
    expect(provider.settings?.read()).toMatchObject({ apiKeySet: false })
    expect(provider.settings?.write({ apiKey: API_KEY })).toBeNull()
  })

  it('refuses what is not a setting', () => {
    expect(provider.settings?.write({ baseUrl: 'ftp://x' })).toMatch(/http\(s\) URL/)
    expect(provider.settings?.write({ baseUrl: 'not a url' })).toMatch(/http\(s\) URL/)
    expect(provider.settings?.write({ permissionMode: 'yolo' })).toMatch(/one of auto, ask, off/)
    expect(provider.settings?.write({ apiKey: 'a b' })).toMatch(/without spaces/)
    // The chat view switch is gone: every session runs in the chat.
    expect(provider.settings?.write({ chatView: true })).toMatch(/unknown setting/)
    expect(provider.settings?.write({ somethingElse: true })).toMatch(/unknown setting/)
  })
})

describe('Qwen Code in the registry', () => {
  it('is offered on macOS and Linux', async () => {
    const { defaultProviders } = await import('../src/infrastructure/providers/registry.js')
    expect(defaultProviders('darwin').map((provider) => provider.id)).toEqual(['claude', 'codex', 'qwen'])
    expect(defaultProviders('linux').map((provider) => provider.id)).toEqual(['claude', 'codex', 'qwen'])
    expect(defaultProviders('win32').map((provider) => provider.id)).toEqual(['claude', 'codex'])
  })
})

describe('what Qwen Code can do', () => {
  let provider: AgentProvider
  beforeAll(async () => {
    const { createQwenProvider } = await import('../src/infrastructure/providers/qwen/index.js')
    provider = createQwenProvider()
  })

  it('runs in the chat, with the cockpit\'s tools from the host: workers there, and a chat session can be sent a message', () => {
    expect(provider.capabilities).toEqual({
      chat: { supported: true },
      endTurnTool: { supported: true },
      messaging: { supported: true },
      terminalTools: { supported: true },
      toolLimits: { supported: false, reason: 'Qwen Code sessions cannot be limited to some tools: a worker with tool limits needs Claude Code.' },
    })
    expect(provider.chatRuntime.workerMode).toBe('auto')
    expect(provider.chatRuntime.reportsTurns).toBe(true)
    expect(provider.messagingOf?.({ runtime: 'sdk' })).toEqual({ supported: true })
    expect(provider.messagingOf?.({ runtime: 'terminal' })).toMatchObject({ supported: false })
  })
})

// Where the registry offers Qwen Code (registry.ts): not on Windows, whose paths and hook quoting differ.
describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('Qwen Code provider', () => {
  let provider: AgentProvider
  const settings = () => JSON.parse(readFileSync(join(qwenHome, 'settings.json'), 'utf8'))

  beforeAll(async () => {
    const { createQwenProvider } = await import('../src/infrastructure/providers/qwen/index.js')
    provider = createQwenProvider()
    // Qwen Code's own state, and what an older cockpit wrote: the first stays, the second goes.
    mkdirSync(qwenHome, { recursive: true })
    writeFileSync(join(qwenHome, 'settings.json'), JSON.stringify({
      $version: 4,
      ui: { theme: 'Dracula' },
      mcpServers: { eml_brain: { url: 'http://old' }, other: { command: 'x' } },
      hooks: { Notification: [{ hooks: [{ type: 'command', command: 'old' }] }] },
    }))
    prepare(provider)
  })

  it('turns telemetry, its own updates, prompt suggestions and its own memory off; keeps its own viewport', () => {
    expect(settings()).toMatchObject({
      $version: 4,
      privacy: { usageStatisticsEnabled: false },
      telemetry: { enabled: false },
      general: { disableAutoUpdate: true },
      security: { auth: { selectedType: 'openai' } },
      ui: { theme: 'Dracula', useTerminalBuffer: true, mouseTracking: true, enablePromptSuggestions: false },
      memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false },
      tools: { toolSearch: { enabled: false } },
    })
  })

  it('registers the host\'s brain MCP endpoint and the cockpit\'s own session tools, the space and session as headers from the session env — no token in the file', () => {
    const headers = { 'x-cockpit-mcp-token': '${COCKPIT_MCP_TOKEN}', 'x-eml-session': '${COCKPIT_SESSION_ID}' }
    expect(settings().mcpServers).toEqual({
      eml_brain: { httpUrl: MCP_URL, headers, trust: true },
      cockpit: { httpUrl: COCKPIT_MCP_URL, headers, trust: true },
      other: { command: 'x' },
    })
    expect(readFileSync(join(qwenHome, 'settings.json'), 'utf8')).not.toContain(MCP_TOKEN)
  })

  it('writes hooks whose text does not change between boots or spaces', () => {
    const { hooks } = settings()
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop'])
    expect(hooks.SessionStart[0].hooks[0].command).toMatch(/ hook session-start$/)
    expect(hooks.SessionStart[1].hooks[0].command).toMatch(/ hook project-block$/)
    // The session's task (task-hook.ts), as plain stdout like the EML hooks.
    expect(hooks.SessionStart[2].hooks[0]).toMatchObject({ timeout: 10, command: expect.stringMatching(/task-hook\.js --plain$/) })
    expect(hooks.UserPromptSubmit[1].hooks[0].command).toMatch(/ hook user-prompt-submit --no-cwd-nudge$/)
    expect(hooks.Stop[1].hooks[0].command).toMatch(/ hook stop$/)
    expect(hooks.Stop[0].hooks[0]).toMatchObject({ type: 'command', async: true, timeout: 5, command: expect.stringContaining('turn-hook.js') })
    expect(JSON.stringify(hooks)).not.toContain('--config')
    expect(JSON.stringify(hooks)).not.toContain(HOOK_TOKEN)
    const first = JSON.stringify(hooks)
    prepare(provider, 'fedcba9876543210')
    expect(JSON.stringify(settings().hooks)).toBe(first)
    expect(readFileSync(join(qwenHome, 'turn-hook.json'), 'utf8')).toContain('fedcba9876543210')
  })

  it('delivers the EML skills and the cockpit\'s own', () => {
    expect(readdirSync(join(qwenHome, 'skills')).sort()).toEqual(['brain-hygiene', 'checkpoint', 'consolidate', 'getting-started', 'report-issue', 'schedule', 'spawn-session', 'task-run'])
  })

  const launch = (unattended: boolean, initialPrompt: string | null = null) =>
    provider.launch({ sessionId: 'c-1', address: 'x-c1', space, providerSessionId: null, resume: false, initialPrompt, unattended })
  // macOS: the cockpit's folders, and the space's EML folder: the sandbox covers the hooks too, and they keep their state there.
  // Linux: no sandbox, as for Claude Code (decision qwen-linux-unattended-classifier-only).
  const sandbox = darwin ? ['--sandbox', 'sandbox-exec', '--include-directories', `${join(home, 'spawn-inbox')},${join(home, 'tasks')},${join(home, 'eml', 'spaces', 'space-1')}`] : []

  it('launches the cockpit\'s own Qwen Code with the host\'s node, under the cockpit\'s session id, in the sandbox on macOS', () => {
    const spec = launch(false, 'hello')
    expect(spec.bin).toBe(process.execPath)
    expect(spec.args).toEqual([join(home, 'qwen', 'bin', 'qwen'), '--session-id', 'c-1', '--approval-mode', 'auto', ...sandbox, '--prompt-interactive', 'hello'])
    expect(spec.args.join(' ')).not.toContain(MCP_TOKEN)
    expect(spec.args.join(' ')).not.toContain(API_KEY)
  })

  it('hands the session its space and the endpoint through the environment — no brain token', () => {
    const { env } = launch(false)
    expect(env).toEqual({
      QWEN_HOME: qwenHome,
      COCKPIT_MCP_TOKEN: MCP_TOKEN,
      EML_HOOK_CONFIG: space.files.emlConfig,
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_MODEL: 'qwen/qwen3.8-27b',
      OPENAI_API_KEY: API_KEY,
    })
  })

  it('follows the user\'s permission settings — except where nobody is watching', () => {
    const modes = () => launch(false).args.slice(3)
    expect(provider.settings?.write({ permissionMode: 'ask' })).toBeNull()
    expect(modes()).toEqual(['--approval-mode', 'default', ...sandbox])
    expect(provider.settings?.write({ permissionMode: 'off' })).toBeNull()
    expect(modes()).toEqual(['--approval-mode', 'yolo'])
    // A worker keeps the classifier (and on macOS the sandbox) whatever the user chose for their own sessions.
    expect(launch(true).args.slice(3)).toEqual(['--approval-mode', 'auto', ...sandbox])
    expect(provider.settings?.write({ permissionMode: 'auto' })).toBeNull()
  })

  it('is not set up until the user installs it, and says how', async () => {
    expect(provider.runtime.version()).toBeNull()
    expect(provider.runtime.problem()).toBe('Qwen Code for the cockpit is not set up yet.')
    expect(provider.runtime.problemHint).toContain('Set up now')
    expect(await provider.auth.signedIn()).toBe(false)
  })

  it('does not start a session without a model endpoint', async () => {
    const { qwenRuntime } = await import('../src/infrastructure/providers/qwen/runtime.js')
    const runtime = qwenRuntime as unknown as { currentVersion: () => string | null }
    const installed = runtime.currentVersion
    runtime.currentVersion = () => '0.27.4'
    try {
      expect(provider.runtime.problem()).toBeNull()
      expect(provider.settings?.write({ model: '' })).toBeNull()
      expect(provider.runtime.problem()).toBe('Qwen Code for the cockpit has no model endpoint yet.')
      expect(await provider.auth.signedIn()).toBe(false)
      expect(provider.settings?.write({ model: 'qwen/qwen3.8-27b' })).toBeNull()
      expect(await provider.auth.signedIn()).toBe(true)
    } finally {
      runtime.currentVersion = installed
    }
  })

  it('resumes under the cockpit\'s id once its chat exists', () => {
    const session = { sessionId: 'c-3', providerSessionId: 'c-3', projectPath: null, greeted: null }
    expect(provider.canResume(session)).toBe(false)
    const chats = join(qwenHome, 'projects', '-work-project', 'chats')
    mkdirSync(chats, { recursive: true })
    writeFileSync(join(chats, 'c-3.jsonl'), '')
    expect(provider.canResume(session)).toBe(true)
    const args = provider.launch({ ...session, address: 'x-c3', space, resume: true, initialPrompt: 'ignored', unattended: false }).args
    expect(args.slice(1, 3)).toEqual(['--resume', 'c-3'])
    expect(args).not.toContain('--prompt-interactive')
    expect(provider.resumeNotFound('No saved session found with ID c-3')).toBe(true)
    provider.deleteTranscript(session)
    expect(provider.canResume(session)).toBe(false)
  })

  it('maps hooks to turn signals', () => {
    const hook = (event: string) => provider.turnSignal({ session_id: 'c-1', hook_event_name: event })
    // Qwen Code fires UserPromptSubmit again, with an empty prompt, after each tool batch: only one with a prompt starts a turn.
    expect(hook('UserPromptSubmit')).toEqual({ kind: 'turn', providerSessionId: 'c-1', state: 'working' })
    expect(provider.turnSignal({ session_id: 'c-1', hook_event_name: 'UserPromptSubmit', prompt: '' })).toEqual({ kind: 'turn', providerSessionId: 'c-1', state: 'working' })
    expect(provider.turnSignal({ session_id: 'c-1', hook_event_name: 'UserPromptSubmit', prompt: 'go on' })).toEqual({ kind: 'turn', providerSessionId: 'c-1', state: 'working', prompt: true })
    expect(hook('PermissionRequest')).toEqual({ kind: 'turn', providerSessionId: 'c-1', state: 'waiting' })
    expect(hook('PostToolUse')).toEqual({ kind: 'turn', providerSessionId: 'c-1', state: 'working' })
    expect(hook('Stop')).toEqual({ kind: 'turn', providerSessionId: 'c-1', state: 'done' })
    // Notification idle_prompt also fires while a tool runs: not a signal.
    expect(hook('Notification')).toBeNull()
    expect(provider.turnSignal({ hook_event_name: 'Stop' })).toBeNull()
  })
})

describe('Qwen Code update cooldown', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.parse('2026-11-18T12:00:00.000Z')
  const at = (days: number) => new Date(now - days * DAY).toISOString()

  it('takes the newest release up to the tagged one that has been published for two days', async () => {
    const { settledVersion } = await import('../src/infrastructure/providers/qwen/runtime.js')
    const packument = {
      'dist-tags': { latest: '0.28.0', preview: '0.28.1-preview.0' },
      time: {
        created: at(400), modified: at(0),
        '0.27.3': at(5), '0.27.4': at(3), '0.27.5-nightly.1': at(2.5), '0.28.0': at(0.5), '0.28.1-preview.0': at(0.2),
      },
    }
    expect(settledVersion(packument, 'latest', now)).toBe('0.27.4')
    expect(settledVersion(packument, 'latest', now + 2 * DAY)).toBe('0.28.0')
    expect(settledVersion(packument, 'preview', now)).toBeNull()
    expect(settledVersion({ 'dist-tags': { latest: '0.28.0' }, time: { '0.28.0': at(0.5) } }, 'latest', now)).toBeNull()
  })
})

describe('Qwen Code chat summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-qwen-chat-test-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const user = (timestamp: string, text: string) =>
    JSON.stringify({ timestamp, type: 'user', message: { role: 'user', parts: [{ text }] } })
  const assistant = (timestamp: string, text: string, promptTokenCount: number) =>
    JSON.stringify({
      timestamp, type: 'assistant', model: 'qwen/qwen3.8-27b',
      message: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text }] },
      usageMetadata: { promptTokenCount, candidatesTokenCount: 40 },
    })

  it('reads prompt, counts, model and context size; skips tool results and system records', async () => {
    const { readChatSummary } = await import('../src/infrastructure/providers/qwen/session-summary.js')
    const file = join(dir, 'abc.jsonl')
    writeFileSync(file, [
      user('2026-11-18T01:00:00.000Z', 'Fix the login bug\nand add a test'),
      JSON.stringify({ timestamp: '2026-11-18T01:00:00.100Z', type: 'system', subtype: 'ui_telemetry' }),
      assistant('2026-11-18T01:00:02.000Z', 'Looking.', 15872),
      JSON.stringify({ timestamp: '2026-11-18T01:00:03.000Z', type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: {} }] } }),
      assistant('2026-11-18T01:00:05.000Z', 'Done.', 16020),
      'not json',
      '',
    ].join('\n'))
    expect(readChatSummary(file, false)).toMatchObject({
      summary: 'Fix the login bug', aiTitle: null, messageCount: 3,
      lastMessageAt: '2026-11-18T01:00:05.000Z', lastReply: 'Done.', model: 'qwen/qwen3.8-27b', contextTokens: 16020,
    })
    expect(readChatSummary(null, false).messageCount).toBe(0)
    expect(readChatSummary(join(dir, 'missing.jsonl'), false).summary).toBeNull()
  })

  it('skips the cockpit\'s greeting: the summary is the user\'s first prompt after it', async () => {
    const { readChatSummary } = await import('../src/infrastructure/providers/qwen/session-summary.js')
    const { GREETING_PROMPT } = await import('../src/session-greeting.js')
    const file = join(dir, 'greeted.jsonl')
    writeFileSync(file, [
      user('2026-11-18T02:00:00.000Z', GREETING_PROMPT),
      assistant('2026-11-18T02:00:01.000Z', 'Hi — what are we working on?', 9000),
      user('2026-11-18T02:00:02.000Z', 'Fix the session titles'),
    ].join('\n'))
    expect(readChatSummary(file, true)).toMatchObject({ summary: 'Fix the session titles', messageCount: 3 })
  })
})
