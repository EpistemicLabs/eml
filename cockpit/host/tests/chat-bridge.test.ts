import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import './setup-home.js'
import { ChatBridge, parseAnswer, type ChatContext } from '../src/chat-bridge.js'
import { InMemoryEventStore } from '../src/application/session-events.js'
import { SessionHandoff } from '../src/application/session-handoff.js'
import { PASTE_IMAGES_DIR } from '../src/paste-images.js'
import type { ImageInput, PermissionAnswer, RuntimeEvent, SessionRuntime, SessionRuntimeFactory, SessionRuntimeStart, ToolServer } from '../src/domain/session-runtime.js'

/**
 * The bridge against a harness that has nothing to do with Claude: no message ids,
 * no blocks, no permission suggestions. If the port were Claude-shaped this adapter
 * could not exist.
 */
class FakeRuntime implements SessionRuntime {
  sent: string[] = []
  images: ImageInput[][] = []
  answers: Array<[string, PermissionAnswer]> = []
  interrupts = 0
  closed = false
  servers: ToolServer[] = [{ name: 'tools', status: 'connected', error: null, scope: 'user', transport: 'web', toolCount: 2 }]
  serverCalls: string[] = []
  constructor(readonly start: SessionRuntimeStart) {}
  emit(event: RuntimeEvent): void { this.start.onEvent(event) }
  send(_id: string, text: string, images: ImageInput[] = []): void { this.sent.push(text); this.images.push(images) }
  async interrupt(): Promise<void> { this.interrupts += 1; this.emit({ kind: 'turn_end', reason: 'interrupted' }) }
  answerPermission(requestId: string, answer: PermissionAnswer): void { this.answers.push([requestId, answer]) }
  modes: string[] = []
  models: string[] = []
  stopped: string[] = []
  async setMode(mode: string): Promise<void> {
    if (mode === 'refused') throw new Error('not allowed')
    this.modes.push(mode)
    this.emit({ kind: 'settings', mode })
  }
  async setModel(model: string): Promise<void> { this.models.push(model) }
  async stopAgent(taskId: string): Promise<void> { this.stopped.push(taskId) }
  async toolServers(): Promise<ToolServer[]> { return this.servers }
  async setToolServerEnabled(name: string, enabled: boolean): Promise<void> { this.serverCalls.push(`${name}:${enabled}`) }
  async reconnectToolServer(name: string): Promise<void> {
    this.serverCalls.push(`${name}:reconnect`)
    if (name === 'broken') throw new Error('no route')
    if (name === 'locked') throw new Error('Server status: needs-auth')
  }
  async close(): Promise<void> { this.closed = true; this.emit({ kind: 'runtime_exit', expected: true }) }
}

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  frames: Array<Record<string, unknown>> = []
  closes: string[] = []
  send(raw: string): void { this.frames.push(JSON.parse(raw) as Record<string, unknown>) }
  close(_code: number, reason: string): void { this.closes.push(reason); this.readyState = WebSocket.CLOSED }
  client(frame: object): void { this.emit('message', Buffer.from(JSON.stringify(frame)), false) }
  events(): RuntimeEvent[] { return this.frames.filter((f) => f.type === 'event').map((f) => f.event as RuntimeEvent) }
  seqs(): number[] { return this.frames.filter((f) => f.type === 'event').map((f) => f.seq as number) }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function setup(opts: { transcript?: boolean; history?: RuntimeEvent[]; runtimeOf?: string; terminalRunning?: boolean } = {}) {
  const runtimes: FakeRuntime[] = []
  const factory: SessionRuntimeFactory = {
    start: (request) => { const runtime = new FakeRuntime(request); runtimes.push(runtime); return runtime },
    history: async () => opts.history ?? [{ kind: 'history_end' }],
  }
  const ledgerEntries = new Map<string, { runtime: string; keepRunning: boolean; chatMode?: string; chatModel?: string; conversation?: string }>()
  if (opts.runtimeOf) ledgerEntries.set('s1', { runtime: opts.runtimeOf, keepRunning: true })
  const provider = {
    id: 'claude',
    runtime: { problem: () => null, problemHint: '' },
    canResume: () => opts.transcript === true,
    trustProject: () => {},
    launch: () => ({ bin: 'x', args: [], keepRunning: false, env: { PROVIDER_VAR: '1', CLAUDE_CODE_OAUTH_TOKEN: 'never-passed' } }),
  }
  const space = {
    id: 'main', url: 'u', token: 't', ledgerKey: null,
    files: { mcpConfig: '/m.json', settings: '/s.json', emlConfig: '/e' },
    registry: { get: () => ({ projectId: 'p1', path: '/work' }) },
    projects: { cached: () => [] },
  }
  const turns: Array<[string, string]> = []
  const ctx = {
    ledger: {
      has: (id: string) => ledgerEntries.has(id),
      get: (id: string) => ledgerEntries.get(id),
      ref: (id: string) => ({ sessionId: 's1', providerSessionId: ledgerEntries.get(id)?.conversation ?? null, projectPath: null, greeted: null }),
      setChatSettings: (id: string, patch: { mode?: string; model?: string }) => {
        const entry = ledgerEntries.get(id)
        if (!entry) return
        if (patch.mode) entry.chatMode = patch.mode
        if (patch.model) entry.chatModel = patch.model
      },
      bindProviderSession: (id: string, conversation: string) => { (ledgerEntries.get(id) as { conversation?: string }).conversation = conversation },
      recordSpawn: (id: string) => { if (!ledgerEntries.has(id)) ledgerEntries.set(id, { runtime: 'terminal', keepRunning: false }) },
      setRuntime: (id: string, runtime: string) => { (ledgerEntries.get(id) as { runtime: string }).runtime = runtime },
      setKeepRunning: (id: string, keep: boolean) => { (ledgerEntries.get(id) as { keepRunning: boolean }).keepRunning = keep },
      touch: () => {},
    },
    providers: { get: () => provider, forSession: () => provider },
    spaces: { get: () => space, main: space, resolve: () => space },
    sessionEnv: { COCKPIT_URL: 'http://host' },
    runtimes: factory,
    events: new InMemoryEventStore(),
    onTurn: (id: string, state: string) => turns.push([id, state]),
  } as unknown as ChatContext
  const terminal = {
    running: opts.terminalRunning === true,
    ended: 0,
    isRunning(): boolean { return this.running },
    async end(): Promise<void> { this.ended += 1; this.running = false },
  }
  let handoff: SessionHandoff
  const bridge = new ChatBridge(ctx, () => handoff)
  handoff = new SessionHandoff({ terminal, sdk: bridge })
  return { bridge, runtimes, ledgerEntries, turns, terminal, handoff }
}

function connect(bridge: ChatBridge, init: object = {}): FakeSocket {
  const ws = new FakeSocket()
  bridge.attach(ws as unknown as WebSocket)
  ws.client({ type: 'init', paneId: 'pane', projectId: 'p1', sessionId: 's1', ...init })
  return ws
}

describe('ChatBridge', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('starts a new session under its id with the session environment and no login token', async () => {
    const { bridge, runtimes, ledgerEntries } = setup()
    connect(bridge)
    await flush()
    const { start } = runtimes[0]
    expect(start.resume).toBe(false)
    expect(start.cwd).toBe('/work')
    expect(start.env).toMatchObject({ PROVIDER_VAR: '1', COCKPIT_URL: 'http://host', COCKPIT_SESSION_ID: 's1' })
    expect(start.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(ledgerEntries.get('s1')?.runtime).toBe('sdk')
  })

  it('leaves the host\'s own environment out', async () => {
    process.env.ANTHROPIC_API_KEY = 'host-only'
    const { bridge, runtimes } = setup()
    connect(bridge)
    await flush()
    delete process.env.ANTHROPIC_API_KEY
    expect(runtimes[0].start.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('takes a session from the terminal only after its process ended, and rebuilds from the transcript', async () => {
    const { bridge, runtimes, terminal, ledgerEntries } = setup({
      transcript: true, runtimeOf: 'terminal', terminalRunning: true,
      history: [{ kind: 'user_message', id: 'old', text: 'from the terminal', queued: false }, { kind: 'history_end' }],
    })
    const ws = connect(bridge)
    await flush()
    expect(terminal.ended).toBe(1)
    expect(runtimes[0].start.resume).toBe(true)
    const kinds = ws.events().map((e) => e.kind)
    expect(kinds).toEqual(['user_message', 'history_end', 'notice'])
    expect(ledgerEntries.get('s1')?.keepRunning).toBe(false)
  })

  it('sends to the runtime and marks a message sent during a turn as queued', async () => {
    const { bridge, runtimes } = setup()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'send', text: 'one' })
    ws.client({ type: 'send', text: 'two' })
    expect(runtimes[0].sent).toEqual(['one', 'two'])
    const queued = ws.events().flatMap((e) => (e.kind === 'user_message' ? [e.queued] : []))
    expect(queued).toEqual([false, true])
  })

  it('a reconnect gets only what it missed, a stale epoch gets everything', async () => {
    const { bridge, runtimes } = setup()
    const first = connect(bridge)
    await flush()
    runtimes[0].emit({ kind: 'text', blockId: 'a', text: 'one' })
    runtimes[0].emit({ kind: 'text', blockId: 'b', text: 'two' })
    const reset = first.frames.find((f) => f.type === 'reset') as { epoch: number }
    const [firstSeq] = first.seqs()
    first.emit('close')

    const again = connect(bridge, { epoch: reset.epoch, after: firstSeq })
    await flush()
    expect(again.events()).toEqual([{ kind: 'text', blockId: 'b', text: 'two' }])

    const stale = connect(bridge, { epoch: reset.epoch + 100, after: 99 })
    await flush()
    expect(stale.frames[0]).toMatchObject({ type: 'reset' })
    expect(stale.events()).toHaveLength(2)
  })

  it('a second client takes the session over and the first is told not to come back', async () => {
    const { bridge, runtimes } = setup()
    const first = connect(bridge)
    await flush()
    connect(bridge)
    await flush()
    expect(first.closes).toEqual(['superseded'])
    expect(runtimes).toHaveLength(1)
  })

  it('a closed socket does not stop the turn, and an open card is served again', async () => {
    const { bridge, runtimes } = setup()
    const first = connect(bridge)
    await flush()
    runtimes[0].emit({ kind: 'question', requestId: 'q1', questions: [] })
    first.emit('close')
    expect(runtimes[0].closed).toBe(false)
    expect(bridge.isRunning('s1')).toBe(true)
    const second = connect(bridge)
    await flush()
    expect(second.events().map((e) => e.kind)).toContain('question')
    second.client({ type: 'answer', requestId: 'q1', answer: { decision: 'answer', answers: { a: 'b' } } })
    expect(runtimes[0].answers).toEqual([['q1', { decision: 'answer', answers: { a: 'b' } }]])
  })

  it('reports waiting while a card is open, and working once it is answered', async () => {
    const { bridge, runtimes, turns } = setup()
    connect(bridge)
    await flush()
    runtimes[0].emit({ kind: 'question', requestId: 'q', questions: [] })
    runtimes[0].emit({ kind: 'request_settled', requestId: 'q', outcome: 'answered' })
    expect(turns).toEqual([['s1', 'waiting'], ['s1', 'working']])
  })

  it('ending interrupts a running turn, closes, and tells the client not to come back', async () => {
    const { bridge, runtimes } = setup()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'send', text: 'go' })
    await bridge.end('s1')
    expect(runtimes[0].interrupts).toBe(1)
    expect(runtimes[0].closed).toBe(true)
    expect(bridge.isRunning('s1')).toBe(false)
    expect(ws.closes).toEqual(['superseded'])
  })

  it('ending with an open card closes without an interrupt: the close settles it', async () => {
    const { bridge, runtimes } = setup()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'send', text: 'go' })
    runtimes[0].emit({ kind: 'question', requestId: 'q', questions: [] })
    await bridge.end('s1')
    expect(runtimes[0].interrupts).toBe(0)
    expect(runtimes[0].closed).toBe(true)
  })

  it('a crash keeps the view, and the next message resumes', async () => {
    const { bridge, runtimes } = setup({ transcript: true, runtimeOf: 'sdk' })
    const ws = connect(bridge)
    await flush()
    runtimes[0].emit({ kind: 'runtime_exit', expected: false })
    expect(bridge.isRunning('s1')).toBe(false)
    ws.client({ type: 'send', text: 'still there?' })
    expect(runtimes).toHaveLength(2)
    expect(runtimes[1].start.resume).toBe(true)
    expect(runtimes[1].sent).toEqual(['still there?'])
  })

  it('a chosen mode and model are remembered and start the next run', async () => {
    const { bridge, runtimes, ledgerEntries } = setup({ transcript: true })
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'set_mode', mode: 'auto' })
    ws.client({ type: 'set_model', model: 'opus[1m]' })
    await flush()
    expect(runtimes[0].modes).toEqual(['auto'])
    expect(ledgerEntries.get('s1')).toMatchObject({ chatMode: 'auto', chatModel: 'opus[1m]' })
    runtimes[0].emit({ kind: 'runtime_exit', expected: false })
    ws.client({ type: 'send', text: 'go on' })
    expect(runtimes[1].start).toMatchObject({ mode: 'auto', model: 'opus[1m]' })
  })

  it('a refused mode is not remembered and shows in the conversation', async () => {
    const { bridge, ledgerEntries } = setup()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'set_mode', mode: 'refused' })
    await flush()
    expect(ledgerEntries.get('s1')?.chatMode).toBeUndefined()
    expect(ws.events()).toContainEqual({ kind: 'error', message: 'not allowed' })
  })

  it('stops a subagent, and ignores a malformed id', async () => {
    const { bridge, runtimes } = setup()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'stop_agent', taskId: 'a1' })
    ws.client({ type: 'stop_agent', taskId: 'bad id!' })
    expect(runtimes[0].stopped).toEqual(['a1'])
  })

  it('follows a cleared conversation: the next run resumes the new one', async () => {
    const { bridge, runtimes } = setup({ transcript: true })
    const ws = connect(bridge)
    await flush()
    runtimes[0].emit({ kind: 'conversation_reset', conversationId: 'new-conversation' })
    runtimes[0].emit({ kind: 'runtime_exit', expected: false })
    ws.client({ type: 'send', text: 'go on' })
    expect(runtimes[1].start.conversationId).toBe('new-conversation')
  })

  it('serves the tool servers on request, outside the event log', async () => {
    const { bridge } = setup()
    const ws = connect(bridge)
    await flush()
    const events = ws.events().length
    ws.client({ type: 'tool_servers' })
    await flush()
    expect(ws.frames.at(-1)).toMatchObject({ type: 'tool_servers', error: null, servers: [{ name: 'tools', toolCount: 2 }] })
    expect(ws.events()).toHaveLength(events)
  })

  it('changes a tool server and answers with the servers as they are now', async () => {
    const { bridge, runtimes } = setup()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'tool_server', name: 'tools', action: 'disable' })
    ws.client({ type: 'tool_server', name: 'tools', action: 'enable' })
    ws.client({ type: 'tool_server', name: 'tools', action: 'reconnect' })
    ws.client({ type: 'tool_server', name: 'tools', action: 'delete' })
    await flush()
    expect(runtimes[0].serverCalls).toEqual(['tools:false', 'tools:true', 'tools:reconnect'])
    expect(ws.frames.at(-1)).toMatchObject({ type: 'tool_servers' })
  })

  it('reports a failed change next to the current servers', async () => {
    const { bridge } = setup()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'tool_server', name: 'broken', action: 'reconnect' })
    await flush()
    expect(ws.frames.at(-1)).toMatchObject({ type: 'tool_servers', error: 'broken: no route', servers: [{ name: 'tools' }] })
  })

  it('a server that wants a sign-in is no failure', async () => {
    const { bridge } = setup()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'tool_server', name: 'locked', action: 'reconnect' })
    await flush()
    expect(ws.frames.at(-1)).toMatchObject({ type: 'tool_servers', error: null })
  })

  it('says so when no runtime is there to ask', async () => {
    const { bridge, runtimes } = setup()
    const ws = connect(bridge)
    await flush()
    runtimes[0].emit({ kind: 'runtime_exit', expected: false })
    ws.client({ type: 'tool_servers' })
    await flush()
    expect(ws.frames.at(-1)).toMatchObject({ type: 'tool_servers', servers: [] })
    expect((ws.frames.at(-1) as { error: string }).error).toContain('not running')
  })

  it('puts pasted images into the message and shows them by url', async () => {
    const name = '11111111-1111-1111-1111-111111111111.png'
    mkdirSync(PASTE_IMAGES_DIR, { recursive: true })
    writeFileSync(join(PASTE_IMAGES_DIR, name), 'pixels')
    const { bridge, runtimes } = setup()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'send', text: '', images: [name] })
    expect(runtimes[0].images[0]).toEqual([{ mediaType: 'image/png', data: Buffer.from('pixels').toString('base64') }])
    expect(ws.events()).toContainEqual(expect.objectContaining({ kind: 'user_message', images: [{ url: `/api/paste-image/${name}` }] }))
  })

  it('refuses an image name that is not one of ours, and sends nothing', async () => {
    const { bridge, runtimes } = setup()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'send', text: 'look', images: ['../../secret.png'] })
    expect(runtimes[0].sent).toEqual([])
    expect(ws.frames).toContainEqual(expect.objectContaining({ type: 'error' }))
  })

  it('refuses another agent\'s session', async () => {
    const { bridge } = setup()
    const ws = new FakeSocket()
    bridge.attach(ws as unknown as WebSocket)
    ws.client({ type: 'init', paneId: 'pane', projectId: 'p1', sessionId: 'bad id!' })
    expect(ws.frames[0]).toMatchObject({ type: 'error' })
  })
})

describe('parseAnswer', () => {
  it('takes known decisions and drops the rest', () => {
    expect(parseAnswer({ decision: 'allow' })).toEqual({ decision: 'allow' })
    expect(parseAnswer({ decision: 'answer', answers: { a: 'b', c: 1 } })).toEqual({ decision: 'answer', answers: { a: 'b' } })
    expect(parseAnswer({ decision: 'yolo' })).toBeNull()
    expect(parseAnswer(null)).toBeNull()
  })
})
