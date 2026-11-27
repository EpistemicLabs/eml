import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { LaunchSpec, SessionRef, SessionSpace } from '../src/domain/agent-provider.js'
import type { RuntimeEvent, SessionRuntime, SessionRuntimeFactory, SessionRuntimeStart } from '../src/domain/session-runtime.js'
import type { ClaudeStartOptions } from '../src/infrastructure/providers/claude/sdk-runtime.js'
import type { JournalWatcher, JournalWatchRequest } from '../src/infrastructure/providers/claude/workflow-journal.js'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-chat-agent-test-'))
process.env.EML_COCKPIT_HOME = home

const sdk = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  dirs: [] as Array<string | undefined>,
  /** Set before a start: the next query's messages come from here until it ends; else it has none. */
  stream: null as null | { push(message: unknown): void; end(): void; messages: AsyncIterable<unknown> },
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { options: Record<string, unknown> }) => {
    sdk.options.push(params.options)
    const stream = sdk.stream
    sdk.stream = null
    const messages = stream?.messages ?? { [Symbol.asyncIterator]: async function* () { /* no messages */ } }
    return { [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close: () => {}, interrupt: async () => {} }
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

/** A stream of SDK messages the test writes to. */
function scriptedStream() {
  const queue: unknown[] = []
  let ended = false
  let wake: (() => void) | null = null
  const stream = {
    push(message: unknown) { queue.push(message); wake?.() },
    end() { ended = true; wake?.() },
    messages: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length > 0) yield queue.shift()
          if (ended) return
          await new Promise<void>((resolve) => { wake = resolve })
          wake = null
        }
      },
    },
  }
  sdk.stream = stream
  return stream
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)) }

// A start request's launch and space, as the bridge passes them on. `limited`: the session has an MCP file of its own.
const plainLaunch: LaunchSpec = { bin: 'claude', args: [], env: {} }
const limitedLaunch: LaunchSpec = { ...plainLaunch, limits: { mcpConfig: '/m', deniedTools: [] } }
const plainSpace: SessionSpace = { id: 'space', mcpToken: 't', files: { mcpConfig: '/m', settings: '/s', emlConfig: '/e' } }

describe('the chat view in a space with its own agent', () => {
  // Each request, and over it what Claude Code's runtime makes of its launch and space (claudeStartOptions).
  const starts: Array<SessionRuntimeStart & ClaudeStartOptions> = []
  const histories: Array<[string, unknown]> = []
  let isolation: typeof import('../src/infrastructure/providers/claude/isolation.js')
  let connect: (spaceId: string, sessionId: string) => FakeSocket
  let spaces: InstanceType<typeof import('../src/brain-space.js')['BrainSpaces']>
  let ledger: InstanceType<typeof import('../src/session-ledger.js')['SessionLedger']>
  let createClaudeSdkRuntimes: typeof import('../src/infrastructure/providers/claude/sdk-runtime.js')['createClaudeSdkRuntimes']
  let claudeStartOptions: typeof import('../src/infrastructure/providers/claude/sdk-runtime.js')['claudeStartOptions']

  beforeAll(async () => {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(agentRoot, 'mcp-servers.json'), JSON.stringify({ mcpServers: { alpha: { command: 'a' } } }))
    writeFileSync(join(agentRoot, 'agent.json'), JSON.stringify({
      agentId: AGENT, mcpServers: ['alpha'], skills: [], tempDir: join(agentRoot, 'tmp'), harnesses: { claude: { configDir } },
    }))
    isolation = await import('../src/infrastructure/providers/claude/isolation.js')
    const { createClaudeProvider } = await import('../src/infrastructure/providers/claude/index.js')
    const { openBrainSpace, BrainSpaces } = await import('../src/brain-space.js')
    const { SessionLedger } = await import('../src/session-ledger.js')
    const { ChatBridge } = await import('../src/chat-bridge.js')
    const { InMemoryEventStore } = await import('../src/application/session-events.js')
    const { SessionHandoff } = await import('../src/application/session-handoff.js')
    const { CLAUDE_TURN_HOOK_CONFIG } = await import('../src/paths.js')
    ;({ createClaudeSdkRuntimes, claudeStartOptions } = await import('../src/infrastructure/providers/claude/sdk-runtime.js'))

    const provider = createClaudeProvider()
    provider.prepare({ hookUrl: 'http://127.0.0.1:60001/api/hook', hookToken: '0123456789abcdef', writableDirs: [] })
    Object.defineProperty(provider.runtime, 'problem', { value: () => null })
    const open = (id: string, main: boolean, agentId?: string) => openBrainSpace({
      id, name: id, agent: agentId ?? null, upgrade: null, main, url: 'http://127.0.0.1:60000', token: 'eml_testprefix_testsecret',
      turnHookConfig: CLAUDE_TURN_HOOK_CONFIG, mcpUrl: 'http://127.0.0.1:60001/mcp', hooksUrl: 'http://127.0.0.1:60001/hooks', ownRuntime: !!agentId,
    })
    spaces = new BrainSpaces(open(PLAIN, true))
    spaces.add(open(SPACE, false, AGENT))
    for (const space of spaces.list()) space.registry.get = (() => ({ projectId: 'p1', path: '/work' })) as never
    ledger = new SessionLedger()
    const runtimes: SessionRuntimeFactory = {
      workerMode: 'auto',
      start: (request) => {
        starts.push({ ...request, ...claudeStartOptions(request) })
        const runtime: SessionRuntime = { send: () => {}, interrupt: async () => {}, answerPermission: () => {}, close: async () => {} }
        return runtime
      },
      history: async (session): Promise<RuntimeEvent[]> => {
        histories.push([session.providerSessionId ?? session.sessionId, session.runtime?.id ?? null])
        return [{ kind: 'history_end' }]
      },
    }
    // The bridge takes the provider's chat runtime: this one in place of the SDK's.
    Object.defineProperty(provider, 'chatRuntime', { value: runtimes })
    const bridge = new ChatBridge({
      ledger, spaces, sessionEnv: {}, events: new InMemoryEventStore(), onTurn: () => {},
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
    const start = { sessionId: 's', resume: false, conversationId: null, mode: null, model: null, cwd: '/work', env: {}, address: 'a', launch: plainLaunch, space: plainSpace, onEvent: () => {} }
    factory.start({ ...start, launch: limitedLaunch })
    factory.start(start)
    const args = sdk.options.slice(-2).map((o) => o.extraArgs as Record<string, unknown>)
    expect(args[0]).toHaveProperty('strict-mcp-config', null)
    expect(args[0]['mcp-config']).toBe('/m')
    expect(args[1]).not.toHaveProperty('strict-mcp-config')
  })

  it('the SDK runtime turns Artifact on unless the session already set it', () => {
    const factory = createClaudeSdkRuntimes()
    const start = { sessionId: 's', resume: false, conversationId: null, mode: null, model: null, cwd: '/work', address: 'a', launch: plainLaunch, space: plainSpace, onEvent: () => {} }
    factory.start({ ...start, env: { KEEP: 'x' } })
    factory.start({ ...start, env: { CLAUDE_CODE_ARTIFACT: '0' } })
    const envs = sdk.options.slice(-2).map((o) => o.env as Record<string, string>)
    expect(envs[0]).toMatchObject({ CLAUDE_CODE_ARTIFACT: '1', KEEP: 'x' })
    expect(envs[1].CLAUDE_CODE_ARTIFACT).toBe('0')
  })

  it('the SDK runtime passes the Chrome flag only when the setting is on and no agent is strict', () => {
    const factory = createClaudeSdkRuntimes()
    const dir = mkdtempSync(join(home, 'chrome-'))
    const env = { CLAUDE_CONFIG_DIR: dir }
    const start = { sessionId: 's', resume: false, conversationId: null, mode: null, model: null, cwd: '/work', env, address: 'a', launch: plainLaunch, space: plainSpace, onEvent: () => {} }
    const chromeArg = () => (sdk.options.at(-1)?.extraArgs as Record<string, unknown>)

    factory.start(start)
    expect(chromeArg()).not.toHaveProperty('chrome')

    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ claudeInChromeDefaultEnabled: false }))
    factory.start(start)
    expect(chromeArg()).not.toHaveProperty('chrome')

    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ claudeInChromeDefaultEnabled: true }))
    factory.start(start)
    expect(chromeArg()).toHaveProperty('chrome', null)

    factory.start({ ...start, launch: limitedLaunch })
    expect(chromeArg()).not.toHaveProperty('chrome')

    writeFileSync(join(dir, '.claude.json'), JSON.stringify({}))
    factory.start({ ...start, launch: { ...limitedLaunch, chrome: true } })
    expect(chromeArg()).toHaveProperty('chrome', null)
  })

  describe('the SDK runtime follows a workflow run\'s journal', () => {
    type Watch = { request: JournalWatchRequest; stopped: boolean }
    const setup = (configDir: string) => {
      const watches: Watch[] = []
      const fake: JournalWatcher = (request) => {
        const watch: Watch = { request, stopped: false }
        watches.push(watch)
        return { stop: () => { watch.stopped = true } }
      }
      const events: RuntimeEvent[] = []
      const stream = scriptedStream()
      const runtime = createClaudeSdkRuntimes(fake).start({
        sessionId: 's', resume: false, conversationId: null, mode: null, model: null, cwd: '/work', env: { CLAUDE_CONFIG_DIR: configDir }, address: 'a',
        launch: plainLaunch, space: plainSpace, onEvent: (event) => events.push(event),
      })
      return { watches, events, stream, runtime }
    }
    const started = (taskId: string, toolId: string) => ({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolId, task_type: 'local_workflow', workflow_name: 'review-changes', description: 'Review' })
    const launched = (taskId: string, toolId: string, result: object) => ({
      type: 'user', parent_tool_use_id: null, session_id: 'c1',
      tool_use_result: { status: 'async_launched', taskId, taskType: 'local_workflow', workflowName: 'review-changes', ...result },
      message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'launched' }] },
    })
    const ended = (taskId: string) => ({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed', output_file: '', summary: '' })

    it('reads the folder the call\'s result names, reports its progress and stops at the run\'s end', async () => {
      const { watches, events, stream } = setup('/cfg')
      stream.push(started('w1', 't1'))
      stream.push(launched('w1', 't1', { runId: 'wf_1', transcriptDir: '/runs/wf_1' }))
      await flush()
      expect(watches).toHaveLength(1)
      expect(watches[0].request.taskId).toBe('w1')
      expect(await watches[0].request.locate()).toBe('/runs/wf_1')
      watches[0].request.onProgress({ running: 2, done: 1, phase: 'Review' })
      expect(events).toContainEqual({ kind: 'workflow_task', taskId: 'w1', running: 2, done: 1, phase: 'Review' })
      stream.push(ended('w1'))
      await flush()
      expect(watches[0].stopped).toBe(true)
      expect(events).toContainEqual({ kind: 'workflow_task', taskId: 'w1', status: 'completed' })
      // A launch read after the end starts nothing.
      stream.push(launched('w1', 't1', { runId: 'wf_1', transcriptDir: '/runs/wf_1' }))
      await flush()
      expect(watches).toHaveLength(1)
      stream.end()
    })

    it('finds the folder by the run id, else the newest run folder since the run started, and stops at the process\'s exit', async () => {
      const dir = mkdtempSync(join(home, 'workflow-config-'))
      const { watches, events, stream } = setup(dir)
      const runs = join(dir, 'projects', '-work', 'c1', 'subagents', 'workflows')
      stream.push(started('w2', 't2'))
      stream.push(launched('w2', 't2', { runId: 'wf_2' }))
      stream.push(started('w3', 't3'))
      stream.push(launched('w3', 't3', {}))
      await flush()
      expect(watches.map((watch) => watch.request.taskId)).toEqual(['w2', 'w3'])
      expect(await watches[0].request.locate()).toBe(join(runs, 'wf_2'))
      // Not made yet.
      expect(await watches[1].request.locate()).toBeNull()
      mkdirSync(join(runs, 'wf_3'), { recursive: true })
      expect(await watches[1].request.locate()).toBe(join(runs, 'wf_3'))
      stream.end()
      await flush()
      expect(watches.map((watch) => watch.stopped)).toEqual([true, true])
      expect(events.at(-1)).toEqual({ kind: 'runtime_exit', expected: false })
    })

    it('stops following when the session is closed', async () => {
      const { watches, stream, runtime } = setup('/cfg')
      stream.push(started('w4', 't4'))
      stream.push(launched('w4', 't4', { transcriptDir: '/runs/wf_4' }))
      await flush()
      await runtime.close()
      expect(watches[0].stopped).toBe(true)
      stream.end()
    })
  })

  it('reads history from each session\'s own folder, one read at a time', async () => {
    const factory = createClaudeSdkRuntimes()
    const runtime = spaces.get(SPACE)?.runtime
    const stored = (sessionId: string, of?: SessionRef['runtime']): SessionRef => ({ sessionId, providerSessionId: null, projectPath: '/work', greeted: null, ...(of ? { runtime: of } : {}) })
    await Promise.all([
      factory.history(stored('a', runtime)),
      factory.history(stored('b')),
      factory.history(stored('c', runtime)),
    ])
    expect(sdk.dirs).toEqual([configDir, join(home, 'claude-config'), configDir])
    await expect(factory.history(stored('d', { ...runtime, configDirs: {} } as never))).rejects.toThrow(/no config folder/)
  })
})
