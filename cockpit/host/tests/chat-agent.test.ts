import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { RuntimeEvent, SessionRuntime, SessionRuntimeFactory, SessionRuntimeStart } from '../src/domain/session-runtime.js'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-chat-agent-test-'))
process.env.EML_COCKPIT_HOME = home

const sdk = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  dirs: [] as Array<string | undefined>,
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { options: Record<string, unknown> }) => {
    sdk.options.push(params.options)
    return { [Symbol.asyncIterator]: async function* () { /* no messages */ }, close: () => {}, interrupt: async () => {} }
  },
  getSessionMessages: async () => {
    const dir = process.env.CLAUDE_CONFIG_DIR
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Still the folder of this read: another read must not have changed it meanwhile.
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(dir)
    sdk.dirs.push(dir)
    return []
  },
}))

const SPACE = 'fe2dcdfb-0000-4bb3-a3b4-d5261f93e165'
const PLAIN = 'aa2dcdfb-0000-4bb3-a3b4-d5261f93e166'
const AGENT = 'test-agent'
const agentRoot = join(home, 'agents', AGENT)
const configDir = join(agentRoot, 'claude-config')

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  frames: Array<Record<string, unknown>> = []
  send(raw: string): void { this.frames.push(JSON.parse(raw) as Record<string, unknown>) }
  close(): void { this.readyState = WebSocket.CLOSED }
  client(frame: object): void { this.emit('message', Buffer.from(JSON.stringify(frame)), false) }
  errors(): unknown[] { return this.frames.filter((f) => f.type === 'error').map((f) => f.message) }
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)) }

describe('the chat view in a space with its own agent', () => {
  const starts: SessionRuntimeStart[] = []
  const histories: Array<[string, unknown]> = []
  let isolation: typeof import('../src/infrastructure/providers/claude/isolation.js')
  let connect: (spaceId: string, sessionId: string) => FakeSocket
  let spaces: InstanceType<typeof import('../src/brain-space.js')['BrainSpaces']>
  let ledger: InstanceType<typeof import('../src/session-ledger.js')['SessionLedger']>
  let createClaudeSdkRuntimes: typeof import('../src/infrastructure/providers/claude/sdk-runtime.js')['createClaudeSdkRuntimes']

  beforeAll(async () => {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(agentRoot, 'mcp-servers.json'), JSON.stringify({ mcpServers: { alpha: { command: 'a' } } }))
    writeFileSync(join(agentRoot, 'agent.json'), JSON.stringify({
      agentId: AGENT, brainId: SPACE, mcpServers: ['alpha'], skills: [], tempDir: join(agentRoot, 'tmp'), harnesses: { claude: { configDir } },
    }))
    isolation = await import('../src/infrastructure/providers/claude/isolation.js')
    const { createClaudeProvider } = await import('../src/infrastructure/providers/claude/index.js')
    const { openBrainSpace, BrainSpaces } = await import('../src/brain-space.js')
    const { SessionLedger } = await import('../src/session-ledger.js')
    const { ChatBridge } = await import('../src/chat-bridge.js')
    const { InMemoryEventStore } = await import('../src/application/session-events.js')
    const { SessionHandoff } = await import('../src/application/session-handoff.js')
    const { CLAUDE_TURN_HOOK_CONFIG } = await import('../src/paths.js')
    ;({ createClaudeSdkRuntimes } = await import('../src/infrastructure/providers/claude/sdk-runtime.js'))

    const provider = createClaudeProvider()
    provider.prepare({ hookUrl: 'http://127.0.0.1:60001/api/hook', hookToken: '0123456789abcdef', writableDirs: [] })
    Object.defineProperty(provider.runtime, 'problem', { value: () => null })
    const open = (id: string, main: boolean, agentId?: string) => openBrainSpace({
      id, name: id, brainName: 'main-agent', main, url: 'http://127.0.0.1:60000', token: 'eml_testprefix_testsecret',
      turnHookConfig: CLAUDE_TURN_HOOK_CONFIG, ...(agentId ? { agentId } : {}),
    })
    spaces = new BrainSpaces(open(PLAIN, true))
    spaces.add(open(SPACE, false, AGENT))
    for (const space of spaces.list()) space.registry.get = (() => ({ projectId: 'p1', path: '/work' })) as never
    ledger = new SessionLedger()
    const runtimes: SessionRuntimeFactory = {
      start: (request) => {
        starts.push(request)
        const runtime: SessionRuntime = { send: () => {}, interrupt: async () => {}, answerPermission: () => {}, close: async () => {} }
        return runtime
      },
      history: async (sessionId, _cwd, agent): Promise<RuntimeEvent[]> => {
        histories.push([sessionId, agent?.id ?? null])
        return [{ kind: 'history_end' }]
      },
    }
    const bridge = new ChatBridge({
      ledger, spaces, sessionEnv: {}, runtimes, events: new InMemoryEventStore(), onTurn: () => {},
      providers: { get: () => provider, forSession: () => provider } as never,
    }, () => handoff)
    const terminal = { isRunning: () => false, end: async () => {} }
    const handoff = new SessionHandoff({ terminal, sdk: bridge })
    connect = (spaceId, sessionId) => {
      const ws = new FakeSocket()
      bridge.attach(ws as unknown as WebSocket)
      ws.client({ type: 'init', paneId: 'pane', projectId: 'p1', sessionId, spaceId })
      return ws
    }
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('runs in the agent\'s folder with its own MCP file, strict, with its temp folder', async () => {
    connect(SPACE, 'chat-a')
    await flush()
    const start = starts.find((s) => s.sessionId === 'chat-a')
    expect(start?.env.CLAUDE_CONFIG_DIR).toBe(configDir)
    expect(start?.env.CLAUDE_CODE_TMPDIR).toBe(join(agentRoot, 'tmp'))
    expect(start?.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
    expect(start?.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
    expect(start?.strictMcp).toBe(true)
    expect(start?.files.mcpConfig.startsWith(configDir)).toBe(true)
    expect(JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')).projects['/work'].hasTrustDialogAccepted).toBe(true)
  })

  it('finds and reads a stored conversation in the agent\'s folder', async () => {
    ledger.recordSpawn('chat-b', 'pane', 'p1', 'claude', false, null, SPACE)
    const dir = join(configDir, 'projects', '-work')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'chat-b.jsonl'), '{}\n')
    connect(SPACE, 'chat-b')
    await flush()
    expect(starts.find((s) => s.sessionId === 'chat-b')?.resume).toBe(true)
    expect(histories).toContainEqual(['chat-b', AGENT])
  })

  it('a space without an agent keeps the shared folder and no strict MCP', async () => {
    connect(PLAIN, 'chat-plain')
    await flush()
    const start = starts.find((s) => s.sessionId === 'chat-plain')
    expect(start?.env.CLAUDE_CONFIG_DIR).toBe(join(home, 'claude-config'))
    expect(start?.strictMcp).toBe(false)
    expect(start?.env).not.toHaveProperty('CLAUDE_CODE_TMPDIR')
  })

  it('refuses when the agent\'s folder is missing, and creates nothing', async () => {
    renameSync(configDir, `${configDir}.away`)
    try {
      const ws = connect(SPACE, 'chat-c')
      await flush()
      expect(ws.errors().join()).toMatch(/config folder .* is missing/)
      expect(starts.find((s) => s.sessionId === 'chat-c')).toBeUndefined()
      expect(ledger.has('chat-c')).toBe(false)
    } finally {
      renameSync(`${configDir}.away`, configDir)
    }
  })

  it('the SDK runtime passes the strict flag only when asked', () => {
    const factory = createClaudeSdkRuntimes()
    const start = { sessionId: 's', resume: false, cwd: '/work', env: {}, address: 'a', files: { mcpConfig: '/m', settings: '/s' }, onEvent: () => {} }
    factory.start({ ...start, strictMcp: true })
    factory.start({ ...start, strictMcp: false })
    const args = sdk.options.slice(-2).map((o) => o.extraArgs as Record<string, unknown>)
    expect(args[0]).toHaveProperty('strict-mcp-config', null)
    expect(args[0]['mcp-config']).toBe('/m')
    expect(args[1]).not.toHaveProperty('strict-mcp-config')
  })

  it('reads history from each session\'s own folder, one read at a time', async () => {
    const factory = createClaudeSdkRuntimes()
    const agent = spaces.get(SPACE)?.agent
    await Promise.all([
      factory.history('a', '/work', agent),
      factory.history('b', '/work'),
      factory.history('c', '/work', agent),
    ])
    expect(sdk.dirs).toEqual([configDir, join(home, 'claude-config'), configDir])
    await expect(factory.history('d', '/work', { ...agent, configDirs: {} } as never)).rejects.toThrow(/no config folder/)
  })
})
