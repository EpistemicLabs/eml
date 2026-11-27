import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPABILITY_IDS, type AgentProvider, type ProviderId, type SessionSpace, type TurnSignal } from '../src/domain/agent-provider.js'

/**
 * What every agent provider owes the host, checked for each adapter the same
 * way: the MCP servers its sessions get, where the tokens are and are not, the
 * session hooks, how a hook payload reads as a turn signal, and capabilities
 * that agree with each other. What only one adapter does is in its own test
 * (claude-provider, codex-provider, qwen-provider).
 *
 * The adapters are built directly, not through the registry: it offers Qwen
 * Code on macOS only, while its prepare(), launch() and turnSignal() write and
 * read plain files on any OS.
 */

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-provider-contract-test-'))
process.env.EML_COCKPIT_HOME = home

const SPACE_ID = 'space-1'
const MCP_TOKEN = 'f'.repeat(64)

/** What the host knows at one boot: the second differs in every token and URL. */
interface Boot { hookUrl: string; hookToken: string; mcpUrl: string; cockpitMcpUrl: string; hooksUrl: string }
const BOOT: Boot = {
  hookUrl: 'http://127.0.0.1:60001/api/hook', hookToken: '0123456789abcdef',
  mcpUrl: 'http://127.0.0.1:60001/mcp', cockpitMcpUrl: 'http://127.0.0.1:60001/mcp/cockpit', hooksUrl: 'http://127.0.0.1:60001/hooks',
}
const NEXT_BOOT: Boot = {
  hookUrl: 'http://127.0.0.1:60002/api/hook', hookToken: 'fedcba9876543210',
  mcpUrl: 'http://127.0.0.1:60002/mcp', cockpitMcpUrl: 'http://127.0.0.1:60002/mcp/cockpit', hooksUrl: 'http://127.0.0.1:60002/hooks',
}

// The space a session runs in. Claude Code reads its files (written by brain-space.ts); Codex and Qwen Code get the token through the session env.
const space: SessionSpace = {
  id: SPACE_ID, mcpToken: MCP_TOKEN,
  files: {
    mcpConfig: join(home, 'claude-config', 'spaces', SPACE_ID, 'mcp.json'),
    settings: join(home, 'claude-config', 'spaces', SPACE_ID, 'settings.json'),
    emlConfig: join(home, 'eml', 'spaces', SPACE_ID, 'config'),
  },
}

/** An MCP server as an adapter registered it: a header's value from the session env reads `${VAR}`, whatever the CLI's own syntax. */
interface Server { url: string; headers: Record<string, string> }

type Signal = [name: string, payload: Record<string, unknown>, expected: TurnSignal | null]
const turn = (state: 'working' | 'done' | 'waiting', extra: Record<string, unknown> = {}): TurnSignal => ({ kind: 'turn', providerSessionId: 'p-1', state, ...extra } as TurnSignal)
const event = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({ session_id: 'p-1', hook_event_name, ...extra })

interface Adapter {
  id: ProviderId
  create(): Promise<AgentProvider>
  /** Everything a boot writes for the CLI: prepare(), and for Claude Code the space's files, which brain-space.ts writes after it. */
  boot(provider: AgentProvider, boot: Boot): Promise<void>
  /** The CLI's own config files with MCP servers and hooks in them. */
  configFiles: string[]
  /** The owner-only file the turn hook reads its URL and token from. */
  turnHookConfig: string
  servers(): Record<string, Server>
  /** The hook entries by event, each as written. */
  hooks(): Record<string, Array<{ command: string; args?: string[] }>>
  /** The MCP token reaches the CLI through the session env; false: through the space's own owner-only file (Claude Code, one mcp.json per space). */
  tokenFromEnv: boolean
  /** The adapter promises hooks whose text does not change between boots (the CLI asks the user to trust a changed hook again, or one file serves every space). */
  stableHooks: boolean
  /** The events that report turn state beside UserPromptSubmit and Stop. */
  turnEvents: string[]
  signals: Signal[]
}

const read = (file: string) => readFileSync(file, 'utf8')

/** `[mcp_servers.<name>]` tables of a config.toml with a url, and their env_http_headers. */
function codexServers(toml: string): Record<string, Server> {
  const servers: Record<string, Server> = {}
  for (const table of toml.split(/^(?=\[)/m)) {
    const name = /^\[mcp_servers\.([\w-]+)\]/.exec(table)?.[1]
    const url = /^url = "([^"]*)"$/m.exec(table)?.[1]
    if (!name || !url) continue
    const headers = /^env_http_headers = \{(.*)\}$/m.exec(table)?.[1] ?? ''
    servers[name] = { url, headers: Object.fromEntries([...headers.matchAll(/"([^"]+)" = "([^"]+)"/g)].map(([, header, env]) => [header, `\${${env}}`])) }
  }
  return servers
}

const claudeDir = join(home, 'claude-config')
const codexDir = join(home, 'codex-config')
const qwenDir = join(home, 'qwen-config')

const ADAPTERS: Adapter[] = [
  {
    id: 'claude',
    create: async () => (await import('../src/infrastructure/providers/claude/index.js')).createClaudeProvider(),
    boot: async (provider, boot) => {
      provider.prepare({ ...boot, writableDirs: [] })
      const { writeSpaceFiles } = await import('../src/infrastructure/providers/claude/isolation.js')
      writeSpaceFiles(SPACE_ID, join(claudeDir, 'turn-hook.json'), { mcpUrl: boot.mcpUrl, hooksUrl: boot.hooksUrl, mcpToken: MCP_TOKEN })
    },
    configFiles: [space.files.mcpConfig, space.files.settings],
    turnHookConfig: join(claudeDir, 'turn-hook.json'),
    servers: () => Object.fromEntries(Object.entries(JSON.parse(read(space.files.mcpConfig)).mcpServers as Record<string, Server>).map(([name, { url, headers }]) => [name, { url, headers }])),
    hooks: () => Object.fromEntries(Object.entries(JSON.parse(read(space.files.settings)).hooks as Record<string, Array<{ hooks: Array<{ command: string; args?: string[] }> }>>)
      .map(([name, entries]) => [name, entries.flatMap((entry) => entry.hooks)])),
    tokenFromEnv: false,
    stableHooks: false,
    turnEvents: ['Notification'],
    signals: [
      ['the user\'s prompt', event('UserPromptSubmit', { prompt: 'go on' }), turn('working', { prompt: true })],
      ['the turn\'s end', event('Stop'), turn('done')],
      ['a permission prompt', event('Notification', { notification_type: 'permission_prompt' }), turn('waiting')],
      ['a notification that asks nothing', event('Notification', { notification_type: 'idle_prompt' }), { kind: 'unclassified', label: 'idle_prompt' }],
      ['a tool that ran', event('PostToolUse'), null],
    ],
  },
  {
    id: 'codex',
    create: async () => (await import('../src/infrastructure/providers/codex/index.js')).createCodexProvider(),
    boot: async (provider, boot) => provider.prepare({ ...boot, writableDirs: [join(home, 'spawn-inbox'), join(home, 'tasks')] }),
    configFiles: [join(codexDir, 'config.toml'), join(codexDir, 'hooks.json')],
    turnHookConfig: join(codexDir, 'turn-hook.json'),
    servers: () => codexServers(read(join(codexDir, 'config.toml'))),
    hooks: () => Object.fromEntries(Object.entries(JSON.parse(read(join(codexDir, 'hooks.json'))).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
      .map(([name, entries]) => [name, entries.flatMap((entry) => entry.hooks)])),
    tokenFromEnv: true,
    stableHooks: true,
    turnEvents: ['PermissionRequest', 'PostToolUse'],
    signals: [
      ['the user\'s prompt', event('UserPromptSubmit', { prompt: 'go on' }), turn('working', { prompt: true })],
      ['a tool that ran', event('PostToolUse'), turn('working')],
      // The reviewer answers first (permission mode auto, the default): waiting only once it had its time.
      ['a permission request', event('PermissionRequest'), turn('waiting', { settleMs: 12_000 })],
      ['the turn\'s end', event('Stop'), turn('done')],
    ],
  },
  {
    id: 'qwen',
    create: async () => (await import('../src/infrastructure/providers/qwen/index.js')).createQwenProvider(),
    boot: async (provider, boot) => provider.prepare({ ...boot, writableDirs: [join(home, 'spawn-inbox'), join(home, 'tasks')] }),
    configFiles: [join(qwenDir, 'settings.json')],
    turnHookConfig: join(qwenDir, 'turn-hook.json'),
    servers: () => Object.fromEntries(Object.entries(JSON.parse(read(join(qwenDir, 'settings.json'))).mcpServers as Record<string, { httpUrl: string; headers: Record<string, string> }>)
      .map(([name, { httpUrl, headers }]) => [name, { url: httpUrl, headers }])),
    hooks: () => Object.fromEntries(Object.entries(JSON.parse(read(join(qwenDir, 'settings.json'))).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
      .map(([name, entries]) => [name, entries.flatMap((entry) => entry.hooks)])),
    tokenFromEnv: true,
    stableHooks: true,
    turnEvents: ['PermissionRequest', 'PostToolUse'],
    signals: [
      ['the user\'s prompt', event('UserPromptSubmit', { prompt: 'go on' }), turn('working', { prompt: true })],
      // Qwen Code fires UserPromptSubmit again after each tool batch, with an empty prompt: the same turn.
      ['the hook after a tool batch', event('UserPromptSubmit', { prompt: '' }), turn('working')],
      ['a prompt hook without a prompt', event('UserPromptSubmit'), turn('working')],
      ['a tool that ran', event('PostToolUse'), turn('working')],
      ['a permission request', event('PermissionRequest'), turn('waiting')],
      ['the turn\'s end', event('Stop'), turn('done')],
    ],
  },
]

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe.each(ADAPTERS)('provider contract: $id', (adapter) => {
  let provider: AgentProvider
  /** A hook's command as one line without quoting: the exec form (Claude Code on Windows) joined, PowerShell's and sh's quotes dropped. */
  const line = (hook: { command: string; args?: string[] }) => [hook.command, ...(hook.args ?? [])].join(' ').replace(/'/g, '')
  const lines = (name: string) => (adapter.hooks()[name] ?? []).map(line)
  const launch = () => provider.launch({ sessionId: 's-1', address: 'x-s1', space, providerSessionId: null, resume: false, initialPrompt: 'hello', unattended: false })

  beforeAll(async () => {
    provider = await adapter.create()
    await adapter.boot(provider, BOOT)
  })

  it('is the adapter of its id', () => {
    expect(provider.id).toBe(adapter.id)
    expect(provider.label).not.toBe('')
  })

  it('registers the brain MCP server, and the cockpit\'s own session tools exactly when its terminal sessions get them', () => {
    const servers = adapter.servers()
    expect(servers.eml_brain?.url).toBe(BOOT.mcpUrl)
    expect('cockpit' in servers).toBe(provider.capabilities.terminalTools.supported)
    if (provider.capabilities.terminalTools.supported) expect(servers.cockpit.url).toBe(BOOT.cockpitMcpUrl)
  })

  it('names the session on every host endpoint from the session env, and the space by its MCP token', () => {
    const hostServers = Object.entries(adapter.servers()).filter(([name]) => name === 'eml_brain' || name === 'cockpit')
    expect(hostServers.length).toBeGreaterThan(0)
    for (const [, server] of hostServers) {
      expect(server.headers['x-eml-session']).toBe('${COCKPIT_SESSION_ID}')
      expect(server.headers['x-cockpit-mcp-token']).toBe(adapter.tokenFromEnv ? '${COCKPIT_MCP_TOKEN}' : MCP_TOKEN)
    }
    // One config for every space: the session's env picks the space.
    if (adapter.tokenFromEnv) expect(launch().env.COCKPIT_MCP_TOKEN).toBe(MCP_TOKEN)
  })

  it('keeps the tokens out of the config files and off the command line', () => {
    for (const file of adapter.configFiles) {
      expect(read(file), file).not.toContain(BOOT.hookToken)
      // Claude Code has one mcp.json per space, owner-only, with that space's token in it.
      if (adapter.tokenFromEnv || file !== space.files.mcpConfig) expect(read(file), file).not.toContain(MCP_TOKEN)
    }
    const args = launch().args.join(' ')
    expect(args).not.toContain(BOOT.hookToken)
    expect(args).not.toContain(MCP_TOKEN)
    // The hook token's one place: the turn hook's own config, owner-only.
    expect(JSON.parse(read(adapter.turnHookConfig))).toEqual({ url: BOOT.hookUrl, token: BOOT.hookToken })
    if (process.platform !== 'win32') expect(statSync(adapter.turnHookConfig).mode & 0o777).toBe(0o600)
  })

  it('starts a session with the EML boot, the project block and its task', () => {
    const start = lines('SessionStart')
    expect(start).toHaveLength(3)
    expect(start[0]).toMatch(/ hook session-start( |$)/)
    expect(start[1]).toMatch(/ hook project-block( |$)/)
    expect(start[2]).toContain('task-hook.js')
  })

  it('reports turn state from the prompt, the stop and what lies between, and runs the EML stop hook', () => {
    for (const name of ['UserPromptSubmit', 'Stop', ...adapter.turnEvents]) {
      expect(lines(name).filter((l) => l.includes('turn-hook.js')), name).toHaveLength(1)
    }
    expect(lines('UserPromptSubmit').some((l) => / hook user-prompt-submit( |$)/.test(l))).toBe(true)
    expect(lines('Stop').some((l) => / hook stop( |$)/.test(l))).toBe(true)
  })

  it.runIf(adapter.stableHooks)('writes the same hook text at the next boot, whatever its tokens and URLs', async () => {
    const first = JSON.stringify(adapter.hooks())
    await adapter.boot(provider, NEXT_BOOT)
    try {
      expect(JSON.stringify(adapter.hooks())).toBe(first)
      expect(first).not.toContain(BOOT.hookToken)
      // The new boot is in the files the hooks and the CLI read at run time.
      expect(JSON.parse(read(adapter.turnHookConfig))).toEqual({ url: NEXT_BOOT.hookUrl, token: NEXT_BOOT.hookToken })
      expect(adapter.servers().eml_brain.url).toBe(NEXT_BOOT.mcpUrl)
    } finally {
      await adapter.boot(provider, BOOT)
    }
  })

  it.each(adapter.signals)('reads %s as a turn signal', (_name, payload, expected) => {
    expect(provider.turnSignal(payload)).toEqual(expected)
  })

  it('reads no signal from an event it does not know or a hook without a session id', () => {
    expect(provider.turnSignal(event('SomethingNew'))).toBeNull()
    expect(provider.turnSignal(event('SessionStart'))).toBeNull()
    for (const [, payload] of adapter.signals) {
      const { session_id: _id, ...withoutId } = payload
      expect(provider.turnSignal(withoutId)).toBeNull()
      expect(provider.turnSignal({ ...withoutId, session_id: '' })).toBeNull()
    }
  })

  it('marks only the user\'s prompt as the start of a new turn', () => {
    const started = adapter.signals.filter(([, , expected]) => expected?.kind === 'turn' && expected.prompt === true)
    expect(started.map(([, payload]) => [payload.hook_event_name, payload.prompt])).toEqual([['UserPromptSubmit', 'go on']])
  })

  it('reads the last reply from the Stop hook\'s payload', () => {
    expect(provider.lastReply(event('Stop', { last_assistant_message: 'Done.' }))).toBe('Done.')
  })

  it('has capabilities that agree with each other, each missing one with its reason', () => {
    const { capabilities } = provider
    expect(Object.keys(capabilities).sort()).toEqual([...CAPABILITY_IDS].sort())
    for (const id of CAPABILITY_IDS) {
      const capability = capabilities[id]
      if (!capability.supported) expect(capability.reason.trim(), id).not.toBe('')
    }
    // Every session runs in the chat: a terminal is only the hidden fallback.
    expect(capabilities.chat.supported).toBe(true)
    expect(provider.chatRuntime).toBeDefined()
    // The end_turn tool has to come from somewhere: the chat runtime, or the host's endpoint for terminal sessions.
    if (capabilities.endTurnTool.supported) expect(capabilities.chat.supported || capabilities.terminalTools.supported).toBe(true)
  })
})
