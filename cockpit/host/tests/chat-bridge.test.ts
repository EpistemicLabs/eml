import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import './setup-home.js'
import { GREETING_PROMPT } from '../src/session-greeting.js'
import { ChatBridge, HELPERS_BACK_SETTLE_MS, IDLE_STOP, RESTART_NOTICE, liftNotice, parseAnswer, type ChatContext } from '../src/chat-bridge.js'
import { InMemoryEventStore } from '../src/application/session-events.js'
import { SessionHandoff } from '../src/application/session-handoff.js'
import { TurnTracker } from '../src/turn-state.js'
import { PASTE_IMAGES_DIR } from '../src/paste-images.js'
import { deriveTurn, reminder, type EndTurn } from '../src/domain/turn-end.js'
import type { ImageInput, PermissionAnswer, RunningCommand, RuntimeEvent, SessionRuntime, SessionRuntimeFactory, SessionRuntimeStart, ToolServer, WorkflowWait } from '../src/domain/session-runtime.js'
import { claudeStartOptions, type ClaudeStartOptions } from '../src/infrastructure/providers/claude/sdk-runtime.js'

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
  /** The request, and over it what Claude Code's runtime makes of its launch and space: the limits and the environment its CLI gets. */
  readonly start: SessionRuntimeStart & ClaudeStartOptions
  constructor(request: SessionRuntimeStart) { this.start = { ...request, ...claudeStartOptions(request) } }
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

function setup(opts: { provider?: 'claude' | 'codex'; transcript?: boolean; history?: RuntimeEvent[]; runtimeOf?: string; terminalRunning?: boolean; busy?: () => 'working' | 'waiting' | null; handoffBeforeStop?: (id: string) => string | null; turnDone?: ChatContext['turnDone']; worksAlone?: ChatContext['worksAlone']; turnContext?: ChatContext['turnContext']; turnWake?: ChatContext['turnWake']; agent?: string | null; tracker?: TurnTracker; zone?: string } = {}) {
  const runtimes: FakeRuntime[] = []
  const factory: SessionRuntimeFactory = {
    workerMode: 'auto',
    start: (request) => { const runtime = new FakeRuntime(request); runtimes.push(runtime); return runtime },
    history: async () => opts.history ?? [{ kind: 'history_end' }],
  }
  const ledgerEntries = new Map<string, { runtime: string; keepRunning: boolean; chatMode?: string; chatModel?: string; conversation?: string }>()
  if (opts.runtimeOf) ledgerEntries.set('s1', { runtime: opts.runtimeOf, keepRunning: true })
  const provider = {
    id: opts.provider ?? 'claude',
    chatRuntime: factory,
    capabilities: { chat: opts.provider === 'codex' ? { supported: false, reason: 'The chat view runs Claude Code sessions only. This session stays in the terminal.' } : { supported: true } },
    runtime: { problem: () => null, problemHint: '' },
    canResume: () => opts.transcript === true,
    trustProject: () => {},
    launch: () => ({ bin: 'x', args: [], keepRunning: false, env: { PROVIDER_VAR: '1', CLAUDE_CODE_OAUTH_TOKEN: 'fake-setup-token' } }),
  }
  const space = {
    id: 'main', url: 'u', token: 't', ledgerKey: null, agent: opts.agent ?? null,
    files: { mcpConfig: '/m.json', settings: '/s.json', emlConfig: '/e' },
    registry: { get: () => ({ projectId: 'p1', path: '/work' }) },
    projects: { cached: () => [] },
  }
  const turns: Array<[string, string] | [string, string, number]> = []
  const helpers: number[] = []
  const workflows: WorkflowWait[][] = []
  const commands: RunningCommand[][] = []
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
      recordSpawn: (id: string, _pane?: unknown, _project?: unknown, _provider?: unknown, worker?: boolean, _task?: unknown, _space?: unknown, greeted?: boolean) => { if (!ledgerEntries.has(id)) ledgerEntries.set(id, { runtime: 'terminal', keepRunning: false, ...(greeted ? { greeted: true } : {}) } as never); if (worker) (ledgerEntries.get(id) as unknown as { worker: boolean }).worker = true },
      setRuntime: (id: string, runtime: string) => { (ledgerEntries.get(id) as { runtime: string }).runtime = runtime },
      setKeepRunning: (id: string, keep: boolean) => { (ledgerEntries.get(id) as { keepRunning: boolean }).keepRunning = keep },
      touch: () => {},
      setAgentTitle: () => {},
      setTurnInFlight: (id: string, inFlight: boolean) => { const entry = ledgerEntries.get(id) as unknown as { inFlight?: boolean } | undefined; if (entry) entry.inFlight = inFlight },
      unarchive: () => {},
      setResult: (id: string, waiting: boolean) => { const entry = ledgerEntries.get(id) as unknown as { result?: boolean } | undefined; if (entry) entry.result = waiting },
      setAttention: (id: string, attention: unknown) => { const entry = ledgerEntries.get(id) as unknown as { attention?: unknown } | undefined; if (entry) entry.attention = attention },
      setUnrouted: (id: string, said: unknown) => { const entry = ledgerEntries.get(id) as unknown as { unrouted?: unknown } | undefined; if (entry) entry.unrouted = said },
    },
    providers: { get: () => provider, forSession: () => provider, default: () => provider },
    spaces: { get: () => space, main: space, resolve: () => space, movedAway: (ledgerSpaceId?: string | null) => (ledgerSpaceId ? `This session moved to ${ledgerSpaceId}. Open it there.` : null) },
    sessionEnv: { COCKPIT_URL: 'http://host' },
    events: new InMemoryEventStore(),
    onTurn: (id: string, state: 'working' | 'done' | 'waiting', settleMs?: number) => {
      turns.push(settleMs ? [id, state, settleMs] : [id, state])
      opts.tracker?.apply({ sessionId: id, state, settleMs })
    },
    onHelpers: (id: string, count: number, waits: WorkflowWait[]) => { helpers.push(count); workflows.push(waits); opts.tracker?.waitOn(id, count, waits) },
    onCommands: (id: string, list: RunningCommand[]) => { commands.push(list); opts.tracker?.commandsOn(id, list) },
    terminalBusy: opts.busy,
    handoffBeforeStop: opts.handoffBeforeStop,
    turnDone: opts.turnDone,
    worksAlone: opts.worksAlone,
    turnContext: opts.turnContext,
    turnWake: opts.turnWake,
    // A fixed moment, so the times in these calls stay ahead of it.
    callTime: () => ({ now: Date.parse('2026-11-25T08:00:00Z'), zone: opts.zone ?? 'UTC' }),
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
  return { bridge, runtimes, ledgerEntries, turns, helpers, workflows, commands, terminal, handoff }
}

function connect(bridge: ChatBridge, init: object = {}): FakeSocket {
  const ws = new FakeSocket()
  bridge.attach(ws as unknown as WebSocket)
  ws.client({ type: 'init', paneId: 'pane', projectId: 'p1', sessionId: 's1', ...init })
  return ws
}

describe('ChatBridge', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('opens a plain new chat with the greeting when it is on, as in the terminal, and records it', async () => {
    const { bridge, runtimes, ledgerEntries } = setup()
    connect(bridge, { readOnly: true, greet: true })
    await flush()
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0].sent).toEqual([GREETING_PROMPT])
    expect(ledgerEntries.get('s1')).toMatchObject({ greeted: true })
    // Told to name itself once by the greeting, not again with every prompt.
    expect(runtimes[0].start.worker?.onPrompt?.() ?? null).toBeNull()
  })

  it('asks a session started by hand to name itself, but not one with a task: it is called by its task', async () => {
    const { bridge, runtimes, ledgerEntries } = setup()
    connect(bridge, { readOnly: true, greet: true, prompt: 'Check the Northwind reply' })
    await flush()
    expect(runtimes[0].start.worker?.onPrompt?.() ?? '').toContain('name it in a few words')
    ;(ledgerEntries.get('s1') as unknown as { taskId: string }).taskId = 'task-1'
    expect(runtimes[0].start.worker?.onPrompt?.() ?? null).toBeNull()
  })

  it('starts a new chat from the launcher with its own first message and model, without the greeting', async () => {
    const { bridge, runtimes, ledgerEntries } = setup()
    connect(bridge, { readOnly: true, greet: true, prompt: 'Check the Northwind reply', model: 'opus' })
    await flush()
    expect(runtimes[0].sent).toEqual(['Check the Northwind reply'])
    expect(runtimes[0].start.model).toBe('opus')
    expect(ledgerEntries.get('s1')).not.toMatchObject({ greeted: true })

    // A known session takes neither: reopening it never sends anything.
    const known = setup({ runtimeOf: 'sdk', transcript: true })
    connect(known.bridge, { readOnly: true, prompt: 'again', model: 'opus' })
    await flush()
    expect(known.runtimes.flatMap((r) => r.sent)).toEqual([])
  })

  it('greets no chat when the greeting is off, nor one the ledger knows (a resume or a worker)', async () => {
    const off = setup()
    connect(off.bridge, { readOnly: true, greet: false })
    await flush()
    expect(off.runtimes).toHaveLength(0)

    const known = setup({ runtimeOf: 'sdk', transcript: true })
    connect(known.bridge, { readOnly: true, greet: true })
    await flush()
    expect(known.runtimes.flatMap((r) => r.sent)).toEqual([])
  })

  it('starts a worker with no client, its prompt as the first message, in auto mode', async () => {
    const { bridge, runtimes, ledgerEntries, turns } = setup()
    const problem = bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'do it', title: 'Job', fromSessionId: 'r', createdAt: '' })
    expect(problem).toBeNull()
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0].start.resume).toBe(false)
    expect(runtimes[0].start.mode).toBe('auto')
    expect(runtimes[0].sent).toEqual(['do it'])
    expect(ledgerEntries.get('s1')?.runtime).toBe('sdk')
    expect(turns).toContainEqual(['s1', 'working'])
    expect(bridge.sessionState('s1')).toBe('detached')
  })

  it('a pane joins a running worker and sees its first message, without a second process', async () => {
    const { bridge, runtimes } = setup()
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'do it', title: null, fromSessionId: 'r', createdAt: '' })
    const ws = connect(bridge)
    await flush()
    expect(runtimes).toHaveLength(1)
    expect(ws.events().some((event) => event.kind === 'user_message' && event.text === 'do it')).toBe(true)
    expect(bridge.sessionState('s1')).toBe('running')
  })

  it('a session whose window closed stops once its time is up, and never mid-turn', async () => {
    const { bridge, runtimes } = setup()
    const ws = connect(bridge)
    await flush()
    runtimes[0].emit({ kind: 'activity', state: 'working' })
    ws.emit('close')
    expect(bridge.sweepIdle(Date.now() + 3 * 24 * 60 * 60 * 1000)).toBe(0)
    runtimes[0].emit({ kind: 'turn_end', reason: 'success' })
    expect(bridge.sweepIdle(Date.now() + 59 * 60 * 1000)).toBe(0)
    expect(bridge.sweepIdle(Date.now() + 61 * 60 * 1000)).toBe(1)
    await flush()
    expect(runtimes[0].closed).toBe(true)
  })

  it('task system: an idle session that worked is asked for its handoff first, then stops once that turn is over', async () => {
    const done: string[] = []
    const { bridge, runtimes } = setup({ handoffBeforeStop: () => 'write your handoff', turnDone: (_id, text) => done.push(text) })
    const ws = connect(bridge)
    await flush()
    runtimes[0].emit({ kind: 'text', text: 'worked on it' })
    runtimes[0].emit({ kind: 'turn_end', reason: 'success' })
    ws.emit('close')
    expect(bridge.sweepIdle(Date.now() + 61 * 60 * 1000)).toBe(0)
    expect(runtimes[0].sent.at(-1)).toBe('write your handoff')
    expect(runtimes[0].closed).toBe(false)
    // Still writing it: no stop.
    expect(bridge.sweepIdle(Date.now() + 3 * 60 * 60 * 1000)).toBe(0)
    runtimes[0].emit({ kind: 'text', text: '### Handoff\nResult: done' })
    runtimes[0].emit({ kind: 'turn_end', reason: 'success' })
    await flush()
    expect(done.at(-1)).toBe('### Handoff\nResult: done')
    expect(runtimes[0].closed).toBe(true)
  })

  it('task system: a session with nothing new to hand off, or none to give, stops without asking', async () => {
    const asked: string[] = []
    const { bridge, runtimes } = setup({ handoffBeforeStop: (id) => { asked.push(id); return null } })
    const ws = connect(bridge)
    await flush()
    ws.emit('close')
    // No turn since it started: nothing to hand off, the rule is not even asked.
    expect(bridge.sweepIdle(Date.now() + 61 * 60 * 1000)).toBe(1)
    expect(asked).toEqual([])
    await flush()
    expect(runtimes[0].closed).toBe(true)
  })

  it('a window open on a quiet session stops it after two hours, and tells the window it sleeps', async () => {
    const { bridge, runtimes } = setup()
    const ws = connect(bridge)
    await flush()
    expect(bridge.sweepIdle(Date.now() + 61 * 60 * 1000)).toBe(0)
    expect(bridge.sweepIdle(Date.now() + 121 * 60 * 1000)).toBe(1)
    await flush()
    expect(runtimes[0].closed).toBe(true)
    expect(ws.closes).toEqual([IDLE_STOP])
  })

  it('puts the process under the ceiling and says in the session when the kernel stopped one of its processes', async () => {
    const { bridge, runtimes } = setup()
    let kills = 1
    const placed: Array<[string, number]> = []
    const released: string[] = []
    const ctx = (bridge as unknown as { ctx: ChatContext }).ctx
    ctx.memory = { unavailable: null, place: (id, pid) => { placed.push([id, pid]); return true }, oomKills: () => kills, release: (id) => released.push(id) }
    ctx.limits = () => ({ session: { memoryBytes: 2 * 1024 ** 3, swapBytes: 0 }, idleMs: 60 * 60 * 1000 })
    const ws = connect(bridge)
    await flush()
    runtimes[0].start.onSpawn?.(4242)
    expect(placed).toEqual([['s1', 4242]])
    // Kills from before this process are not news.
    bridge.sweepIdle()
    expect(ws.events().filter((e) => e.kind === 'notice')).toEqual([])
    kills = 2
    bridge.sweepIdle()
    const notices = ws.events().filter((e) => e.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect((notices[0] as { text: string }).text).toContain('2 GB')
    bridge.sweepIdle()
    expect(ws.events().filter((e) => e.kind === 'notice')).toHaveLength(1)
    // The agent itself was the one stopped: the session says it stopped.
    kills = 3
    runtimes[0].emit({ kind: 'runtime_exit', expected: false })
    expect((ws.events().filter((e) => e.kind === 'notice')[1] as { text: string }).text).toContain('The session stopped')
    expect(released).toEqual(['s1'])
  })

  it('over the cap, a session that starts makes the quietest one at rest stop', async () => {
    const { bridge, runtimes } = setup()
    const ctx = (bridge as unknown as { ctx: ChatContext }).ctx
    let cap = 0
    ctx.overCap = () => cap > 0 && bridge.runningCount() > cap
    bridge.startWorker({ id: 'old', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    runtimes[0].emit({ kind: 'turn_end', reason: 'success' })
    ;(bridge as unknown as { entries: Map<string, { lastActivity: number }> }).entries.get('old')!.lastActivity -= 10 * 60 * 1000
    cap = 1
    bridge.startWorker({ id: 'new', projectId: 'p1', prompt: 'y', title: null, fromSessionId: 'r', createdAt: '' })
    await flush()
    expect(runtimes[0].closed).toBe(true)
    expect(runtimes[1].closed).toBe(false)
    expect(bridge.runningCount()).toBe(1)
  })

  it('makes no room from a session at work', async () => {
    const { bridge } = setup()
    bridge.startWorker({ id: 'busy', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    ;(bridge as unknown as { entries: Map<string, { lastActivity: number }> }).entries.get('busy')!.lastActivity -= 10 * 60 * 1000
    expect(bridge.stopOneForRoom()).toBe(false)
  })

  it('a crashed session frees its entry and reports it', async () => {
    const exits: string[] = []
    const { bridge, runtimes } = setup()
    ;(bridge as unknown as { ctx: { onExit: (id: string) => void } }).ctx.onExit = (id) => exits.push(id)
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    runtimes[0].emit({ kind: 'runtime_exit', expected: false })
    expect(exits).toEqual(['s1'])
    expect(bridge.sweepIdle()).toBe(1)
  })

  it('a message reaches a running session, and resumes a stopped one', async () => {
    const { bridge, runtimes, ledgerEntries } = setup({ transcript: true, runtimeOf: 'terminal' })
    ;(ledgerEntries.get('s1') as { projectId?: string }).projectId = 'p1'
    ;(bridge as unknown as { ctx: { providers: { forSession: () => unknown } } }).ctx.providers.forSession = (bridge as unknown as { ctx: { providers: { get: () => unknown } } }).ctx.providers.get
    expect(await bridge.deliver('s1', 'first')).toBe('resumed')
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0].start.resume).toBe(true)
    expect(runtimes[0].sent).toEqual(['first'])
    expect(await bridge.deliver('s1', 'second')).toBe('delivered')
    expect(runtimes[0].sent).toEqual(['first', 'second'])
  })

  it('a message for a session being closed is refused for now, not lost', async () => {
    const { bridge, runtimes } = setup()
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    const closing = bridge.end('s1')
    expect(await bridge.deliver('s1', 'late')).toBe('busy')
    await closing
    expect(runtimes[0].sent).toEqual(['x'])
  })

  it('a message for a session it does not know is unknown', async () => {
    const { bridge } = setup()
    expect(await bridge.deliver('nope', 'x')).toBe('unknown')
  })

  it('a worker that ends its turn without saying is asked once, then marked for review', async () => {
    const { bridge, runtimes, ledgerEntries, turns } = setup()
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    const worker = runtimes[0].start.worker
    expect(await worker?.onTurnEnding()).toBe(reminder(['call']))
    expect(await worker?.onTurnEnding()).toBeNull()
    runtimes[0].emit({ kind: 'turn_end', reason: 'success' })
    expect((ledgerEntries.get('s1') as unknown as { attention: unknown }).attention).toEqual({ kind: 'review', reason: null })
    // Finished work waits to be looked at; it holds no turn open.
    expect(turns).not.toContainEqual(['s1', 'waiting'])
  })

  it('a worker whose task the owner took back is their conversation: not sent back, and a silent turn leaves no review', async () => {
    const { bridge, runtimes, ledgerEntries } = setup({ worksAlone: async () => false })
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    expect(await runtimes[0].start.worker?.onTurnEnding()).toBeNull()
    runtimes[0].emit({ kind: 'turn_end', reason: 'success' })
    expect((ledgerEntries.get('s1') as unknown as { attention?: unknown }).attention ?? null).toBeNull()
  })

  it('a session whose kind cannot be read goes by how it was started', async () => {
    const { bridge, runtimes } = setup({ worksAlone: async () => { throw new Error('brain down') } })
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    expect(await runtimes[0].start.worker?.onTurnEnding()).toBe(reminder(['call']))
  })

  it('a worker that says it needs someone keeps that until a new message comes', async () => {
    const { bridge, runtimes, ledgerEntries } = setup()
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    const attention = () => (ledgerEntries.get('s1') as unknown as { attention: unknown }).attention
    runtimes[0].start.worker?.report('question', 'A or B?')
    runtimes[0].emit({ kind: 'text', blockId: 'b1', text: 'Which one: A or B?' })
    expect(await runtimes[0].start.worker?.onTurnEnding()).toBeNull()
    runtimes[0].emit({ kind: 'turn_end', reason: 'success' })
    expect(attention()).toEqual({ kind: 'question', reason: 'A or B?' })
    void bridge.deliver('s1', 'A')
    expect(attention()).toBeNull()
  })

  it('sends a turn back once when its reply does not ask the questions, or is missing', async () => {
    const { bridge, runtimes } = setup()
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    const worker = runtimes[0].start.worker!
    worker.report('question', 'confirm start date, terms, usage')
    runtimes[0].emit({ kind: 'thinking', blockId: 't1', text: 'Which start date? Which terms?' })
    runtimes[0].emit({ kind: 'text', blockId: 'b1', text: 'I need those three answers before I change anything.' })
    expect(await worker.onTurnEnding()).toBe(reminder(['questions']))
    expect(await worker.onTurnEnding()).toBeNull()
    void bridge.deliver('s1', 'next')
    worker.report('done', 'finished')
    expect(await worker.onTurnEnding()).toBe(reminder(['reply']))
  })

  describe('end_turn', () => {
    const ctx = { owner: 'lasse', agent: 'atlas', members: ['lasse', 'dominik', 'atlas', 'motti'] }
    const started = (opts: Parameters<typeof setup>[0] = {}) => {
      const made = setup({ turnContext: async () => ({ ctx, task: { id: 't1', name: 'Refund', open: true } }), ...opts })
      made.bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      const attention = () => (made.ledgerEntries.get('s1') as unknown as { attention?: unknown }).attention
      return { ...made, runtime: made.runtimes[0], worker: made.runtimes[0].start.worker!, attention }
    }

    it.each<[string, EndTurn, { kind: string; reason: string }]>([
      ['failed', { result: 'Stuck at the login', failed: 'No access to the shop' }, { kind: 'failed', reason: 'No access to the shop' }],
      ['questions', { result: 'Draft ready', questions: ['Send it today?', 'To whom?'], next: { who: 'atlas', what: 'send', when: '2026-11-27T10:00' } }, { kind: 'question', reason: 'Send it today?' }],
      ['the owner next', { result: 'Draft ready', next: { who: 'lasse', what: 'read the draft' } }, { kind: 'review', reason: 'Draft ready' }],
      ['another member next', { result: 'Draft ready', next: { who: 'dominik', what: 'sign it' } }, { kind: 'done', reason: 'Draft ready' }],
      ['someone outside next', { result: 'Mail sent', next: { who: 'outside:Acme', what: 'answer the mail' } }, { kind: 'done', reason: 'Mail sent' }],
      ['itself next, at a time', { result: 'Mail sent', next: { who: 'atlas', what: 'look for the answer', when: '2026-11-27T10:00' } }, { kind: 'done', reason: 'Mail sent' }],
      ['nothing next', { result: 'All done' }, { kind: 'done', reason: 'All done' }],
    ])('a call with %s sets the session\'s attention', async (_row, call, expected) => {
      const { worker, attention } = started()
      const recorded = await worker.endTurn(call)
      expect(attention()).toEqual(expected)
      expect(recorded.derived.status).toBe(expected.kind)
    })

    it('keeps the call and its context in the ledger until the router wrote it into the task', async () => {
      const { worker, ledgerEntries } = started()
      const call: EndTurn = { result: 'Draft ready', questions: ['Send it today?'] }
      await worker.endTurn(call)
      expect((ledgerEntries.get('s1') as unknown as { unrouted?: unknown }).unrouted).toEqual({ call, ctx })
    })

    it('answers with what the call lacks', async () => {
      const { worker } = started()
      expect(await worker.endTurn({ result: 'Half way' })).toMatchObject({ missing: ['next'] })
      // A step for anyone but the owner needs the time the agent looks again.
      for (const who of ['me', 'dominik', 'outside:Acme']) expect(await worker.endTurn({ result: 'Half way', next: { who, what: 'go on' } }), who).toMatchObject({ missing: ['when'] })
      expect(await worker.endTurn({ result: 'Half way', next: { who: 'dominik', what: 'go on', when: '2026-11-27T10:00' } })).toMatchObject({ missing: [] })
      expect(await worker.endTurn({ result: 'Half way', next: { who: 'lasse', what: 'decide' } })).toMatchObject({ missing: [] })
    })

    it('refuses a call whose time has passed: nothing is recorded, no wake-up is asked for', async () => {
      const checks: unknown[] = []
      const { worker, attention } = started({ turnWake: async (_id, wake) => { checks.push(wake.edit); return { problem: null, saved: null, nextRun: false } } })
      await expect(worker.endTurn({ result: 'Sent', next: { who: 'atlas', what: 'look again', when: '2026-11-25T07:59' } }))
        .rejects.toThrow('next.when "2026-11-25T07:59" has passed (read in UTC); name a time that is still to come')
      expect(attention() ?? null).toBeNull()
      expect(checks).toEqual([])
      // The turn then counts as one without a call.
      expect(await worker.onTurnEnding()).toBe(reminder(['call']))
      // A hand-over to the user sets no check: its time is not used, so a passed one refuses nothing.
      expect(await worker.endTurn({ result: 'Sent', next: { who: 'lasse', what: 'read it', when: '2026-11-25T07:59' } })).toMatchObject({ derived: { status: 'review', checkAt: null }, missing: [] })
      // The hand-over clears the task's wake-up, whoever set it.
      expect(checks).toEqual([{ kind: 'clear', whose: 'any' }])
    })

    it('reads a call against the space\'s agent and nobody else when the host gives no context, or its context fails', async () => {
      const call = { result: 'Draft ready', next: { who: 'nova', what: 'look again', when: '2026-11-27T10:00' } }
      for (const turnContext of [undefined, async () => { throw new Error('the brain does not answer') }]) {
        const ends: Array<{ ctx: unknown }> = []
        const made = setup({ agent: 'nova', turnContext, turnDone: (_id, _text, turn) => ends.push(turn) })
        made.bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
        const worker = made.runtimes[0].start.worker!
        // Its own handle is known; no task is: an open one cannot be missing a next step.
        expect(await worker.endTurn(call)).toMatchObject({ derived: { status: 'done', wait: null, checkAt: '2026-11-27T10:00' }, missing: [] })
        expect((await worker.endTurn({ result: 'Draft ready' })).missing).toEqual([])
        // "user" names the owner whatever their handle; any other handle is someone outside.
        expect((await worker.endTurn({ result: 'Draft ready', next: { who: 'user', what: 'read it' } })).derived).toMatchObject({ status: 'review', wait: { who: 'user', kind: 'review' } })
        expect((await worker.endTurn({ result: 'Draft ready', next: { who: 'sam', what: 'sign it', when: '2026-11-27T10:00' } })).derived.wait).toMatchObject({ who: 'sam', kind: 'outside' })
        made.runtimes[0].emit({ kind: 'turn_end', reason: 'success' })
        // The router gets the same context the answer was read against.
        expect(ends[0].ctx).toEqual({ owner: 'user', agent: 'nova', members: [] })
      }
      // No agent bound: the session goes by a word that names itself.
      const bare = setup()
      bare.bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      expect((await bare.runtimes[0].start.worker!.endTurn({ result: 'x', next: { who: 'agent', what: 'look', when: '2026-11-27T10:00' } })).derived.wait).toBeNull()
    })

    it('a closed task asks for no next step', async () => {
      const { worker } = started({ turnContext: async () => ({ ctx, task: { id: 't1', name: 'Refund', open: false } }) })
      expect((await worker.endTurn({ result: 'Closed it' })).missing).toEqual([])
    })

    it('hands the wake-up to the host and tells the agent when it could not be set', async () => {
      const edits: unknown[] = []
      const { worker } = started({ turnWake: async (_id, wake) => {
        edits.push(wake.edit)
        return wake.edit.kind === 'set' && wake.edit.when === '2028-01-01T10:00' ? { problem: 'at most a year ahead', fix: 'time', saved: null, nextRun: false } : { problem: null, saved: null, nextRun: false }
      } })
      expect((await worker.endTurn({ result: 'Sent', next: { who: 'atlas', what: 'look again', when: '2026-11-27T10:00' } })).checkProblem).toBeUndefined()
      const far = await worker.endTurn({ result: 'Sent', next: { who: 'atlas', what: 'look again', when: '2028-01-01T10:00' } })
      expect(far).toMatchObject({ checkProblem: 'at most a year ahead', checkFix: 'time' })
      await worker.endTurn({ result: 'Sent' })
      // A call without a time goes there too: the wake-up this session set earlier is cleared.
      expect(edits).toEqual([{ kind: 'set', when: '2026-11-27T10:00' }, { kind: 'set', when: '2028-01-01T10:00' }, { kind: 'clear', whose: 'own' }])
    })

    it('asks for no time, and records the wait, when the task has a next run from its schedule', async () => {
      const { worker } = started({ turnWake: async () => ({ problem: null, saved: null, nextRun: true }) })
      expect(await worker.endTurn({ result: 'Sent', next: { who: 'atlas', what: 'look again' } })).toMatchObject({ derived: { status: 'done', wait: null, checkAt: null }, missing: [], nextRun: true })
      expect(await worker.endTurn({ result: 'Sent', next: { who: 'outside:Acme', what: 'answers' } }))
        .toMatchObject({ derived: { wait: { who: 'Acme', kind: 'outside', why: 'answers' } }, missing: [], nextRun: true })
      // Without a next run the same calls lack the time.
      const bare = started({ turnWake: async () => ({ problem: null, saved: null, nextRun: false }) })
      expect((await bare.worker.endTurn({ result: 'Sent', next: { who: 'atlas', what: 'look again' } })).missing).toEqual(['when'])
    })

    it('reads next.when in the user\'s time zone, names the instant the schedule saved, and tells the session the zone (the process runs in UTC)', async () => {
      const made = setup({ zone: 'Asia/Bangkok', turnWake: async () => ({ problem: null, saved: { at: Date.parse('2026-11-25T13:15:00Z'), zone: 'Asia/Bangkok' }, nextRun: true }) })
      made.bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      expect(made.runtimes[0].start.timeZone).toBe('Asia/Bangkok (UTC+7)')
      const worker = made.runtimes[0].start.worker!
      // 20:15 in Bangkok is 13:15 UTC, not 20:15 UTC.
      expect((await worker.endTurn({ result: 'Sent', next: { who: 'atlas', what: 'look again', when: '2026-11-25T20:15' } })).checkTime)
        .toEqual({ at: Date.parse('2026-11-25T13:15:00Z'), zone: 'Asia/Bangkok' })
      // 14:59 in Bangkok was 07:59 UTC: passed, although 14:59 UTC is still to come.
      await expect(worker.endTurn({ result: 'Sent', next: { who: 'atlas', what: 'look again', when: '2026-11-25T14:59' } }))
        .rejects.toThrow('next.when "2026-11-25T14:59" has passed (read in Asia/Bangkok)')
    })

    it('names no saved instant for a check that could not be set', async () => {
      const made = setup({ zone: 'Asia/Bangkok', turnWake: async () => ({ problem: 'the task\'s schedule could not be written (the brain does not answer)', fix: 'again', saved: null, nextRun: false }) })
      made.bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      expect((await made.runtimes[0].start.worker!.endTurn({ result: 'Sent', next: { who: 'atlas', what: 'look again', when: '2026-11-25T20:15' } })).checkTime).toBeUndefined()
    })

    it('reminds a worker that stops without a call, once', async () => {
      const { worker, runtime } = started()
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'Did it.' })
      expect(await worker.onTurnEnding()).toBe(reminder(['call']))
      expect(await worker.onTurnEnding()).toBeNull()
    })

    it('reminds for the reply when nothing visible follows the call, also when the reply was written before it', async () => {
      const { worker, runtime } = started()
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'The files are fine.' })
      runtime.emit({ kind: 'tool_call', toolId: 'c2', name: 'mcp__cockpit__end_turn', toolKind: 'other', title: 'end_turn', input: {} })
      await worker.endTurn({ result: 'Read them', next: { who: 'lasse', what: 'read it' } })
      expect(await worker.onTurnEnding()).toBe(reminder(['reply']))
      expect(await worker.onTurnEnding()).toBeNull()
    })

    it('takes the reply written after the call', async () => {
      const { worker, runtime } = started()
      runtime.emit({ kind: 'tool_call', toolId: 'c2', name: 'mcp__cockpit__end_turn', toolKind: 'other', title: 'end_turn', input: {} })
      await worker.endTurn({ result: 'Checked the files', next: { who: 'lasse', what: 'read it' } })
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'The files are fine.' })
      // Work after the reply (a note to the brain) does not take it back.
      runtime.emit({ kind: 'tool_call', toolId: 'c3', name: 'mcp__eml_brain__eml_log', toolKind: 'other', title: 'eml_log', input: {} })
      expect(await worker.onTurnEnding()).toBeNull()
    })

    it('a second call in the turn starts the reply over: what stood between the calls is not it', async () => {
      const { worker, runtime } = started()
      await worker.endTurn({ result: 'Half way' })
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'One more call.' })
      runtime.emit({ kind: 'tool_call', toolId: 'c2', name: 'mcp__cockpit__end_turn', toolKind: 'other', title: 'end_turn', input: {} })
      await worker.endTurn({ result: 'Half way', next: { who: 'lasse', what: 'read it' } })
      expect(await worker.onTurnEnding()).toBe(reminder(['reply']))
    })

    it('reminds when the call has questions the reply does not ask', async () => {
      const { worker, runtime } = started()
      await worker.endTurn({ result: 'Draft ready', questions: ['Send it today?'] })
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'The draft is ready and waits for your word.' })
      expect(await worker.onTurnEnding()).toBe(reminder(['questions']))
      expect(await worker.onTurnEnding()).toBeNull()
    })

    it('while someone has the session open, reminds only for a missing reply, not for unasked questions or a missing call', async () => {
      const made = setup({ turnContext: async () => ({ ctx, task: { id: 't1', name: 'Refund', open: true } }) })
      connect(made.bridge, { prompt: 'Draft the mail' })
      await flush()
      const runtime = made.runtimes[0]
      const worker = runtime.start.worker!
      expect(await worker.onTurnEnding()).toBeNull()
      await worker.endTurn({ result: 'Draft ready', questions: ['Send it today?'] })
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'The draft is ready and waits for your word.' })
      expect(await worker.onTurnEnding()).toBeNull()
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      void made.bridge.deliver('s1', 'next')
      await worker.endTurn({ result: 'Draft ready', questions: ['Send it today?'] })
      // An empty answer helps nobody, watched or not; the questions are theirs to ask back.
      expect(await worker.onTurnEnding()).toBe(reminder(['reply']))
      expect(await worker.onTurnEnding()).toBeNull()
    })

    it('never reminds twice in one turn: the call it was asked for is not sent back for its reply', async () => {
      const { worker } = started()
      expect(await worker.onTurnEnding()).toBe(reminder(['call']))
      await worker.endTurn({ result: 'Draft ready', questions: ['Send it today?'] })
      expect(await worker.onTurnEnding()).toBeNull()
    })

    it('names a missing reply and its unasked questions in the one reminder', async () => {
      const { worker } = started()
      await worker.endTurn({ result: 'Draft ready', questions: ['Send it today?'] })
      expect(await worker.onTurnEnding()).toBe(reminder(['reply', 'questions']))
    })

    it('passes the call and the reminder on with the turn\'s end, and starts the next turn clean', async () => {
      const ends: Array<[string, unknown]> = []
      const { worker, runtime, bridge } = started({ turnDone: (_id, text, turn) => ends.push([text, turn]) })
      const call = { result: 'Draft ready', next: { who: 'lasse', what: 'read it' } }
      expect(await worker.onTurnEnding()).toBe(reminder(['call']))
      await worker.endTurn(call)
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'The draft is ready.' })
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      void bridge.deliver('s1', 'thanks')
      runtime.emit({ kind: 'text', blockId: 'b2', text: 'Welcome.' })
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      expect(ends).toEqual([
        ['The draft is ready.', { call, ctx, reminded: true, said: true }],
        ['Welcome.', { call: null, ctx: null, reminded: false, said: false }],
      ])
    })

    it('keeps a call that arrives over the cockpit MCP endpoint like its own: the reply is what follows the call', async () => {
      const ends: Array<[string, unknown]> = []
      const { worker, runtime, bridge, attention } = started({ turnDone: (_id, text, turn) => ends.push([text, turn]) })
      const call: EndTurn = { result: 'Draft ready', questions: ['Send it today?'] }
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'Let me write the draft.' })
      // The agent CLI calls the tool on the host's endpoint: the chat shows the call, the endpoint hands it on (cockpit-mcp.ts).
      runtime.emit({ kind: 'tool_call', toolId: 't1', name: 'mcp__cockpit__end_turn', toolKind: 'other', title: 'mcp__cockpit__end_turn', input: call })
      expect(bridge.said('s1', { call, ctx, derived: deriveTurn(call, ctx) })).toBe(true)
      expect(attention()).toEqual({ kind: 'question', reason: 'Send it today?' })
      // Nothing written after the call yet: the reply and its question are missing.
      expect(await worker.onTurnEnding()).toBe(reminder(['reply', 'questions']))
      runtime.emit({ kind: 'text', blockId: 'b2', text: 'The draft is ready. Send it today?' })
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      expect(ends).toEqual([['Let me write the draft.The draft is ready. Send it today?', { call, ctx, reminded: true, said: true }]])
    })

    it('keeps nothing for a session it does not run', () => {
      const { bridge, ledgerEntries } = setup()
      const call: EndTurn = { result: 'Done' }
      expect(bridge.said('nobody', { call, ctx, derived: deriveTurn(call, ctx) })).toBe(false)
      expect(ledgerEntries.size).toBe(0)
    })

    it('does not send back the turn a delivered reminder starts: the stop had its one reminder', async () => {
      const ends: unknown[] = []
      const { worker, runtime, bridge } = started({ turnDone: (_id, _text, turn) => ends.push(turn) })
      await worker.endTurn({ result: 'Half done' })
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'Half of it is done.' })
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      // The next-step check's reminder (application/next-step.ts) arrives as a message.
      void bridge.deliver('s1', reminder(['next']), { reminder: true })
      runtime.emit({ kind: 'text', blockId: 'b2', text: 'OK' })
      expect(await worker.onTurnEnding()).toBeNull()
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      expect(ends).toEqual([{ call: { result: 'Half done' }, ctx, reminded: false, said: true }, { call: null, ctx: null, reminded: true, said: false }])
      // Any other message starts a turn that can be reminded.
      void bridge.deliver('s1', 'and now?')
      expect(await worker.onTurnEnding()).toBe(reminder(['call']))
    })
  })

  it('a worker whose turn ends while its subagents run is not asked, flagged or handed off until they are back', async () => {
    const done: string[] = []
    const { bridge, runtimes, ledgerEntries } = setup({ turnDone: (_id, text) => done.push(text) })
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    const runtime = runtimes[0]
    const worker = runtime.start.worker!
    const attention = () => (ledgerEntries.get('s1') as unknown as { attention?: unknown }).attention
    runtime.emit({ kind: 'agent_task', taskId: 'a1', toolId: null, description: 'grade batch 1', agentType: null, status: 'running', background: true })
    runtime.emit({ kind: 'agent_task', taskId: 'a2', toolId: null, description: 'grade batch 2', agentType: null, status: 'running', background: true })
    runtime.emit({ kind: 'agent_task', taskId: 'a1', status: 'completed' })
    // A background shell alone would not hold it: only subagents do.
    runtime.emit({ kind: 'shell_task', taskId: 'sh1', status: 'running' })
    runtime.emit({ kind: 'text', blockId: 'b1', text: 'Waiting on batch 2.' })
    expect(await worker.onTurnEnding()).toBeNull()
    runtime.emit({ kind: 'turn_end', reason: 'success' })
    expect(attention()).toBeFalsy()
    expect(done).toEqual([])

    // The subagent wakes it: that turn is judged on its own and handed off.
    runtime.emit({ kind: 'agent_task', taskId: 'a2', status: 'completed' })
    expect(await worker.onTurnEnding()).toBe(reminder(['call']))
    worker.report('review', 'Report ready')
    runtime.emit({ kind: 'text', blockId: 'b2', text: 'Report is ready to check.' })
    expect(await worker.onTurnEnding()).toBeNull()
    runtime.emit({ kind: 'turn_end', reason: 'success' })
    expect(attention()).toEqual({ kind: 'review', reason: 'Report ready' })
    expect(done).toEqual(['Report is ready to check.'])
  })

  describe('a background shell', () => {
    const shell = (taskId: string, description = 'Run the tests'): RuntimeEvent => ({ kind: 'shell_task', taskId, toolId: null, description, status: 'running' })

    it('shows as a running command from its start until it ends, without holding the turn open', async () => {
      const done: string[] = []
      const tracker = new TurnTracker()
      const { bridge, runtimes, commands, helpers, turns } = setup({ tracker, turnDone: (_id, text) => done.push(text) })
      bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      const runtime = runtimes[0]
      const before = Date.now()
      runtime.emit(shell('sh1'))
      // Said again by the runtime: nothing new.
      runtime.emit(shell('sh1'))
      expect(commands).toHaveLength(1)
      expect(commands[0]).toEqual([{ description: 'Run the tests', since: expect.any(String) }])
      expect(Date.parse(commands[0][0].since)).toBeGreaterThanOrEqual(before - 1000)
      runtime.emit(shell('sh2', 'Build the app'))
      expect(commands[1].map((c) => c.description)).toEqual(['Run the tests', 'Build the app'])

      // The turn ends while both run: done as usual, handed off, nothing held.
      runtime.start.worker!.report('done', null)
      expect(bridge.holdTurnOpen('s1')).toBe(false)
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'Tests are running.' })
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      expect(done).toEqual(['Tests are running.'])
      expect(helpers).toEqual([])
      tracker.apply({ sessionId: 's1', state: 'done' })
      expect(tracker.get('s1')).toMatchObject({ state: 'done', commands: [{ description: 'Run the tests' }, { description: 'Build the app' }] })
      expect(turns.at(-1)).toEqual(['s1', 'working'])

      runtime.emit({ kind: 'shell_task', taskId: 'sh1', status: 'completed' })
      expect(commands.at(-1)?.map((c) => c.description)).toEqual(['Build the app'])
      // An end it never saw start says nothing.
      runtime.emit({ kind: 'shell_task', taskId: 'other', status: 'completed' })
      expect(commands).toHaveLength(3)
      runtime.emit({ kind: 'shell_task', taskId: 'sh2', status: 'stopped' })
      expect(commands.at(-1)).toEqual([])
      expect(tracker.get('s1')?.commands).toBeUndefined()
    })

    it('ends with the process: its commands are cleared on an exit, and when the session ends without one', async () => {
      const crashed = setup()
      crashed.bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      crashed.runtimes[0].emit(shell('sh1'))
      crashed.runtimes[0].emit({ kind: 'runtime_exit', expected: false })
      expect(crashed.commands.at(-1)).toEqual([])

      const { bridge, runtimes, commands } = setup()
      bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      // A runtime that closes without saying its process exited.
      runtimes[0].close = async () => { runtimes[0].closed = true }
      runtimes[0].emit(shell('sh1'))
      await bridge.end('s1', 'archived')
      expect(commands).toEqual([[{ description: 'Run the tests', since: expect.any(String) }], []])
    })
  })

  it('keeps a status unrouted, and a turn that ends while the session closes leaves it for after the restart', async () => {
    const done: string[] = []
    const { bridge, runtimes, ledgerEntries } = setup({ turnDone: (_id, text) => done.push(text) })
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    const runtime = runtimes[0]
    runtime.start.worker!.report('question', 'Install alpha.15?')
    expect((ledgerEntries.get('s1') as unknown as { unrouted?: unknown }).unrouted).toEqual({ call: null, ctx: null })
    runtime.emit({ kind: 'text', blockId: 'b1', text: 'Please install alpha.15.' })
    // The host goes down: the session closes, and its turn ends meanwhile.
    const closing = bridge.end('s1', 'host shutdown')
    runtime.emit({ kind: 'turn_end', reason: 'success' })
    await closing
    expect(done).toEqual([])
    expect((ledgerEntries.get('s1') as unknown as { unrouted?: unknown }).unrouted).toEqual({ call: null, ctx: null })
  })

  it('a worker that asks the user while its subagents run stops as usual', async () => {
    const done: string[] = []
    const { bridge, runtimes, ledgerEntries } = setup({ turnDone: (_id, text) => done.push(text) })
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    const runtime = runtimes[0]
    runtime.emit({ kind: 'agent_task', taskId: 'a1', toolId: null, description: 'research', agentType: null, status: 'running', background: true })
    runtime.start.worker!.report('question', 'A or B?')
    runtime.emit({ kind: 'text', blockId: 'b1', text: 'Which one: A or B?' })
    runtime.emit({ kind: 'turn_end', reason: 'success' })
    expect((ledgerEntries.get('s1') as unknown as { attention?: unknown }).attention).toEqual({ kind: 'question', reason: 'A or B?' })
    expect(done).toEqual(['Which one: A or B?'])
  })

  describe('a session whose turn ended while its subagents run', () => {
    const agent = (taskId: string, status: 'running' | 'completed' | 'stopped' = 'running'): RuntimeEvent =>
      status === 'running'
        ? { kind: 'agent_task', taskId, toolId: null, description: taskId, agentType: null, status, background: true }
        : { kind: 'agent_task', taskId, status }
    /** A worker with these subagents running whose Stop hook came and whose turn then ended. */
    const parked = (agents: string[], opts: Parameters<typeof setup>[0] = {}) => {
      const s = setup(opts)
      s.bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      const runtime = s.runtimes[0]
      for (const id of agents) runtime.emit(agent(id))
      const held = s.bridge.holdTurnOpen('s1')
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      s.turns.length = 0
      return { ...s, runtime, held }
    }

    it('waits on its helpers while they run and it asks nobody, not otherwise', async () => {
      const { bridge, runtimes } = setup()
      expect(bridge.waitsOnHelpers('unknown')).toBe(false)
      expect(bridge.holdTurnOpen('unknown')).toBe(false)
      bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      const runtime = runtimes[0]
      expect(bridge.waitsOnHelpers('s1')).toBe(false)
      // A background shell is not a helper.
      runtime.emit({ kind: 'shell_task', taskId: 'sh1', status: 'running' })
      expect(bridge.waitsOnHelpers('s1')).toBe(false)
      runtime.emit(agent('a1'))
      expect(bridge.waitsOnHelpers('s1')).toBe(true)
      runtime.start.worker!.report('done', null)
      expect(bridge.waitsOnHelpers('s1')).toBe(true)
      runtime.start.worker!.report('question', 'A or B?')
      expect(bridge.waitsOnHelpers('s1')).toBe(false)
      expect(bridge.holdTurnOpen('s1')).toBe(false)
    })

    it('says how many it waits for, and each one that comes back', async () => {
      const { runtime, held, helpers, turns } = parked(['a1', 'a2'])
      expect(held).toBe(true)
      expect(helpers).toEqual([2])
      runtime.emit(agent('a1', 'completed'))
      expect(helpers).toEqual([2, 1])
      expect(turns).toEqual([])
    })

    it('is done a moment after the last one came back, when no turn follows', async () => {
      const { runtime, helpers, turns } = parked(['a1'])
      runtime.emit(agent('a1', 'stopped'))
      expect(helpers).toEqual([1, 0])
      expect(turns).toEqual([['s1', 'done', HELPERS_BACK_SETTLE_MS]])
      // The same end, said twice by the runtime: one done.
      runtime.emit(agent('a1', 'stopped'))
      expect(turns).toHaveLength(1)
    })

    it('stays working through the turn its helpers wake, and is done after it', async () => {
      vi.useFakeTimers()
      try {
        const tracker = new TurnTracker()
        const states: string[] = []
        tracker.on('turn', (event: { state: string; helpers?: number }) => states.push(event.helpers ? `${event.state}:${event.helpers}` : event.state))
        const { runtime, bridge } = parked(['a1'], { tracker })
        expect(tracker.get('s1')).toMatchObject({ state: 'working', helpers: 1 })
        runtime.emit(agent('a1', 'completed'))
        vi.advanceTimersByTime(HELPERS_BACK_SETTLE_MS - 1)
        // The turn the helper woke: the done about to show is taken back.
        runtime.emit({ kind: 'activity', state: 'working' })
        vi.advanceTimersByTime(HELPERS_BACK_SETTLE_MS * 2)
        expect(tracker.get('s1')).toMatchObject({ state: 'working' })
        expect(tracker.get('s1')?.helpers).toBeUndefined()
        expect(states).not.toContain('done')
        // Its Stop hook is applied now: nothing holds it.
        expect(bridge.holdTurnOpen('s1')).toBe(false)
        runtime.emit({ kind: 'turn_end', reason: 'success' })
        expect(states).toEqual(['working', 'working:1', 'working', 'working'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('is done on its own when the woken turn never comes', async () => {
      vi.useFakeTimers()
      try {
        const tracker = new TurnTracker()
        const { runtime } = parked(['a1'], { tracker })
        runtime.emit(agent('a1', 'completed'))
        expect(tracker.get('s1')?.state).toBe('working')
        vi.advanceTimersByTime(HELPERS_BACK_SETTLE_MS)
        expect(tracker.get('s1')?.state).toBe('done')
      } finally {
        vi.useRealTimers()
      }
    })

    it('a turn woken by text alone counts as working again', async () => {
      const { runtime, turns } = parked(['a1', 'a2'])
      runtime.emit(agent('a1', 'completed'))
      runtime.emit({ kind: 'text_delta', blockId: 'b1', delta: 'Batch 1 is back.' })
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'Batch 1 is back.' })
      expect(turns).toEqual([['s1', 'working']])
    })

    it('a message from the user starts a turn: working, and the wait is over', async () => {
      const { bridge, turns } = parked(['a1'])
      void bridge.deliver('s1', 'How far are you?')
      expect(turns).toEqual([['s1', 'working']])
    })

    it('is done when the last helper came back between its Stop hook and its turn end', async () => {
      const { bridge, runtimes, turns, helpers } = setup()
      bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      const runtime = runtimes[0]
      runtime.emit(agent('a1'))
      expect(bridge.holdTurnOpen('s1')).toBe(true)
      runtime.emit(agent('a1', 'completed'))
      turns.length = 0
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      expect(turns).toEqual([['s1', 'done']])
      expect(helpers).toEqual([])
    })

    it('is done when the user stops it, not left working', async () => {
      const { runtime, turns } = parked(['a1'])
      await runtime.interrupt()
      expect(turns).toEqual([['s1', 'done']])
      // Its helper ending later tells nothing new.
      runtime.emit(agent('a1', 'completed'))
      expect(turns).toEqual([['s1', 'done']])
    })

    it('is done when its process is closed: nothing wakes it any more', async () => {
      const { bridge, turns } = parked(['a1'])
      await bridge.end('s1', IDLE_STOP)
      expect(turns).toEqual([['s1', 'done']])
    })

    it('a crash leaves the turn state to the exit, with nothing held', async () => {
      const { bridge, runtime, turns } = parked(['a1'])
      runtime.emit({ kind: 'runtime_exit', expected: false })
      expect(turns).toEqual([])
      expect(bridge.waitsOnHelpers('s1')).toBe(false)
    })

    it('a turn that asks the user while helpers run is not held', async () => {
      const { bridge, runtimes, turns, helpers } = setup()
      bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      const runtime = runtimes[0]
      runtime.emit(agent('a1'))
      runtime.start.worker!.report('question', 'A or B?')
      expect(bridge.holdTurnOpen('s1')).toBe(false)
      turns.length = 0
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      runtime.emit(agent('a1', 'completed'))
      expect(turns).toEqual([])
      expect(helpers).toEqual([])
    })
  })

  describe('a session whose turn ended while a workflow run goes on', () => {
    const workflow = (taskId: string, status?: 'running' | 'completed' | 'failed' | 'stopped', progress: { running?: number; done?: number; phase?: string } = {}): RuntimeEvent =>
      status === 'running'
        ? { kind: 'workflow_task', taskId, toolId: 't1', name: 'review-changes', status }
        : { kind: 'workflow_task', taskId, ...(status ? { status } : {}), ...progress }
    const start = (opts: Parameters<typeof setup>[0] = {}) => {
      const s = setup(opts)
      s.bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      return { ...s, runtime: s.runtimes[0] }
    }

    it('waits on a running workflow like on a subagent, and counts it as running in the background', () => {
      const { bridge, runtime } = start()
      runtime.emit(workflow('w1', 'running'))
      expect(bridge.waitsOnHelpers('s1')).toBe(true)
      expect(bridge.backgroundTasks('s1')).toBe(1)
      // How far it is changes nothing about that.
      runtime.emit(workflow('w1', undefined, { running: 2, done: 1, phase: 'Review' }))
      expect(bridge.waitsOnHelpers('s1')).toBe(true)
      runtime.emit(workflow('w1', 'completed'))
      expect(bridge.waitsOnHelpers('s1')).toBe(false)
      expect(bridge.backgroundTasks('s1')).toBe(0)
    })

    it('is not asked, flagged or handed off while the run goes on, and says how far its agents are', async () => {
      const done: string[] = []
      const { bridge, runtime, ledgerEntries, turns, helpers, workflows } = start({ turnDone: (_id, text) => done.push(text) })
      const worker = runtime.start.worker!
      runtime.emit(workflow('w1', 'running'))
      runtime.emit(workflow('w1', undefined, { running: 3, done: 0, phase: 'Review' }))
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'The review runs.' })
      expect(await worker.onTurnEnding()).toBeNull()
      expect(bridge.holdTurnOpen('s1')).toBe(true)
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      expect((ledgerEntries.get('s1') as unknown as { attention?: unknown }).attention).toBeFalsy()
      expect(done).toEqual([])
      expect(helpers).toEqual([0])
      expect(workflows).toEqual([[{ name: 'review-changes', running: 3, done: 0 }]])
      turns.length = 0
      runtime.emit(workflow('w1', undefined, { running: 2, done: 1, phase: 'Review' }))
      expect(workflows.at(-1)).toEqual([{ name: 'review-changes', running: 2, done: 1 }])
      // Its end: done a moment later, unless the turn it wakes starts.
      runtime.emit(workflow('w1', 'completed'))
      expect(workflows.at(-1)).toEqual([])
      expect(turns).toEqual([['s1', 'done', HELPERS_BACK_SETTLE_MS]])
    })

    it('waits for the subagents and the workflow together, until the last of them is back', () => {
      const { runtime, turns, helpers, workflows, bridge } = start()
      runtime.emit(workflow('w1', 'running'))
      runtime.emit({ kind: 'agent_task', taskId: 'a1', toolId: null, description: 'research', agentType: null, status: 'running', background: true })
      bridge.holdTurnOpen('s1')
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      turns.length = 0
      expect(helpers).toEqual([1])
      runtime.emit({ kind: 'agent_task', taskId: 'a1', status: 'completed' })
      expect(helpers.at(-1)).toBe(0)
      expect(workflows.at(-1)).toHaveLength(1)
      expect(turns).toEqual([])
      runtime.emit(workflow('w1', 'stopped'))
      expect(turns).toEqual([['s1', 'done', HELPERS_BACK_SETTLE_MS]])
    })

    it('shows the wait in the turn state, and ends it with the run', () => {
      vi.useFakeTimers()
      try {
        const tracker = new TurnTracker()
        const { runtime, bridge } = start({ tracker })
        runtime.emit(workflow('w1', 'running'))
        bridge.holdTurnOpen('s1')
        tracker.apply({ sessionId: 's1', state: 'working' })
        runtime.emit({ kind: 'turn_end', reason: 'success' })
        expect(tracker.get('s1')).toMatchObject({ state: 'working', workflows: [{ name: 'review-changes', running: 0, done: 0 }] })
        expect(tracker.get('s1')?.helpers).toBeUndefined()
        runtime.emit(workflow('w1', undefined, { running: 4, done: 2 }))
        expect(tracker.get('s1')?.workflows).toEqual([{ name: 'review-changes', running: 4, done: 2 }])
        runtime.emit(workflow('w1', 'completed'))
        expect(tracker.get('s1')?.workflows).toBeUndefined()
        vi.advanceTimersByTime(HELPERS_BACK_SETTLE_MS)
        expect(tracker.get('s1')?.state).toBe('done')
      } finally {
        vi.useRealTimers()
      }
    })

    it('progress of a run it does not know, or before the turn ended, says nothing', () => {
      const { runtime, helpers } = start()
      runtime.emit(workflow('w9', undefined, { running: 1, done: 0 }))
      runtime.emit(workflow('w1', 'running'))
      runtime.emit(workflow('w1', undefined, { running: 1, done: 0 }))
      expect(helpers).toEqual([])
    })

    it('a turn that asks the user while the run goes on is a stop', () => {
      const done: string[] = []
      const { runtime, bridge, ledgerEntries } = start({ turnDone: (_id, text) => done.push(text) })
      runtime.emit(workflow('w1', 'running'))
      runtime.start.worker!.report('question', 'A or B?')
      expect(bridge.holdTurnOpen('s1')).toBe(false)
      runtime.emit({ kind: 'text', blockId: 'b1', text: 'Which one: A or B?' })
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      expect((ledgerEntries.get('s1') as unknown as { attention?: unknown }).attention).toEqual({ kind: 'question', reason: 'A or B?' })
      expect(done).toEqual(['Which one: A or B?'])
    })

    it('the run goes with the process: nothing is held after it exits', () => {
      const { runtime, bridge, turns } = start()
      runtime.emit(workflow('w1', 'running'))
      bridge.holdTurnOpen('s1')
      runtime.emit({ kind: 'turn_end', reason: 'success' })
      turns.length = 0
      runtime.emit({ kind: 'runtime_exit', expected: true })
      expect(turns).toEqual([['s1', 'done']])
      expect(bridge.waitsOnHelpers('s1')).toBe(false)
      expect(bridge.backgroundTasks('s1')).toBe(0)
    })
  })

  it('a worker that says done stays listed without a turn held open', async () => {
    const worker = setup()
    worker.bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    worker.runtimes[0].start.worker?.report('done', null)
    worker.runtimes[0].emit({ kind: 'turn_end', reason: 'success' })
    expect((worker.ledgerEntries.get('s1') as unknown as { attention?: unknown }).attention).toEqual({ kind: 'done', reason: null })
    expect(worker.turns).not.toContainEqual(['s1', 'waiting'])
  })

  it('a session started by hand can report and name itself, is never sent back, and a silent turn just leaves a result', async () => {
    const own = setup()
    connect(own.bridge)
    await flush()
    const reporting = own.runtimes[0].start.worker
    expect(await reporting?.onTurnEnding()).toBeNull()
    const entry = own.ledgerEntries.get('s1') as unknown as { attention?: unknown; result?: boolean; agentTitle?: string }
    expect(reporting?.onPrompt?.()).toContain('COCKPIT_TITLE_JS')
    entry.agentTitle = 'Named'
    expect(reporting?.onPrompt?.()).toBeNull()
    own.runtimes[0].emit({ kind: 'turn_end', reason: 'success' })
    expect(entry.attention ?? null).toBeNull()
    expect(entry.result).toBe(true)
    reporting?.report('question', 'A or B?')
    // The flag holds the question; the session is not set to waiting (only a live prompt is).
    expect(entry.attention).toMatchObject({ kind: 'question', reason: 'A or B?' })
    expect(own.turns).not.toContainEqual(['s1', 'waiting'])
  })

  it('an interrupted turn leaves no result', async () => {
    const own = setup()
    connect(own.bridge)
    await flush()
    own.runtimes[0].emit({ kind: 'turn_end', reason: 'interrupted' })
    expect((own.ledgerEntries.get('s1') as unknown as { result?: boolean }).result ?? false).toBe(false)
  })

  describe('a turn the user stopped', () => {
    it('is no longer working, and leaves no result, flag or handoff', async () => {
      const done: string[] = []
      const tracker = new TurnTracker()
      const { bridge, runtimes, ledgerEntries, turns } = setup({ tracker, turnDone: (_id, text) => done.push(text) })
      bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      expect(tracker.get('s1')?.state).toBe('working')
      runtimes[0].emit({ kind: 'text', blockId: 'b1', text: 'Half way.' })
      runtimes[0].emit({ kind: 'turn_end', reason: 'interrupted' })
      expect(tracker.get('s1')?.state).toBe('done')
      expect(turns.filter(([, state]) => state === 'done')).toEqual([['s1', 'done']])
      const entry = ledgerEntries.get('s1') as unknown as { result?: boolean; attention?: unknown }
      expect(entry.result ?? false).toBe(false)
      expect(entry.attention ?? null).toBeNull()
      expect(done).toEqual([])
    })

    it('keeps the commands it still runs, so it shows as waiting for them', async () => {
      const tracker = new TurnTracker()
      const { bridge, runtimes } = setup({ tracker })
      bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      runtimes[0].emit({ kind: 'shell_task', taskId: 'sh1', toolId: null, description: 'Run the tests', status: 'running' })
      runtimes[0].emit({ kind: 'turn_end', reason: 'interrupted' })
      expect(tracker.get('s1')).toMatchObject({ state: 'done', commands: [{ description: 'Run the tests' }] })
    })

    it('a turn that ends on its own still leaves its done to the Stop hook, with a result and a handoff', async () => {
      const done: string[] = []
      const tracker = new TurnTracker()
      const { bridge, runtimes, ledgerEntries, turns } = setup({ tracker, turnDone: (_id, text) => done.push(text) })
      bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
      runtimes[0].emit({ kind: 'text', blockId: 'b1', text: 'All done.' })
      runtimes[0].emit({ kind: 'turn_end', reason: 'success' })
      expect(turns.filter(([, state]) => state === 'done')).toEqual([])
      expect(tracker.get('s1')?.state).toBe('working')
      expect((ledgerEntries.get('s1') as unknown as { result?: boolean }).result).toBe(true)
      expect(done).toEqual(['All done.'])
    })
  })

  it('a worker keeps its tool profile on the runtime', async () => {
    const { bridge, runtimes } = setup()
    let stored: unknown
    const ctx = (bridge as unknown as { ctx: { ledger: { setToolProfile?: (id: string, profile: unknown) => void }; providers: { get: () => { launch: () => object } } } }).ctx
    ctx.ledger.setToolProfile = (_id, profile) => { stored = profile }
    const provider = ctx.providers.get()
    const launch = provider.launch
    provider.launch = () => ({ ...launch(), limits: { mcpConfig: '/limited.json', deniedTools: ['Bash'] } })
    const toolProfile = { deniedTools: ['Bash'], mcpServers: ['messages'] }
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '', toolProfile })
    expect(stored).toEqual(toolProfile)
    expect(runtimes[0].start.files.mcpConfig).toBe('/limited.json')
    expect(runtimes[0].start.strictMcp).toBe(true)
    expect(runtimes[0].start.deniedTools).toEqual(['Bash'])
  })

  it('a read-only view shows the conversation and starts nothing until it is used', async () => {
    const { bridge, runtimes } = setup({ transcript: true, runtimeOf: 'terminal', history: [{ kind: 'text', blockId: 'b', text: 'earlier' }, { kind: 'history_end' }] })
    const ws = connect(bridge, { readOnly: true })
    await flush()
    expect(runtimes).toHaveLength(0)
    expect(ws.events().some((event) => event.kind === 'text')).toBe(true)
    expect(bridge.isRunning('s1')).toBe(false)
    ws.client({ type: 'start' })
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0].start.resume).toBe(true)
    ws.client({ type: 'start' })
    expect(runtimes).toHaveLength(1)
  })

  it('a message in a read-only view starts it too', async () => {
    const { bridge, runtimes } = setup()
    const ws = connect(bridge, { readOnly: true })
    await flush()
    ws.client({ type: 'send', text: 'hi' })
    expect(runtimes[0].sent).toEqual(['hi'])
  })

  it('tells the host the user wrote on a send from a client, not on start or interrupt', async () => {
    const { bridge } = setup()
    const wrote: string[] = []
    ;(bridge as unknown as { ctx: ChatContext }).ctx.userWrote = (id) => wrote.push(id)
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'start' })
    ws.client({ type: 'interrupt' })
    expect(wrote).toEqual([])
    ws.client({ type: 'send', text: 'go on' })
    expect(wrote).toEqual(['s1'])
  })

  it('a read-only view joins a running session as it is', async () => {
    const { bridge, runtimes } = setup()
    connect(bridge)
    await flush()
    connect(bridge, { readOnly: true })
    await flush()
    expect(runtimes).toHaveLength(1)
    expect(bridge.isRunning('s1')).toBe(true)
  })

  it('a view of a session a terminal holds does not stay read-only', async () => {
    const { bridge, runtimes, terminal } = setup({ transcript: true, runtimeOf: 'terminal', terminalRunning: true })
    ;(bridge as unknown as { ctx: { terminalRuns: () => boolean } }).ctx.terminalRuns = () => terminal.running
    connect(bridge, { readOnly: true })
    await flush()
    expect(terminal.ended).toBe(1)
    expect(runtimes).toHaveLength(1)
  })

  it('a worker\'s turn counts as cut off only if the host goes down during it', async () => {
    const { bridge, runtimes, ledgerEntries } = setup()
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    const inFlight = () => (ledgerEntries.get('s1') as unknown as { inFlight?: boolean }).inFlight
    expect(inFlight()).toBe(true)
    runtimes[0].emit({ kind: 'turn_end', reason: 'success' })
    expect(inFlight()).toBe(false)
    void bridge.deliver('s1', 'more')
    expect(inFlight()).toBe(true)
    runtimes[0].emit({ kind: 'activity', state: 'working' })
    await bridge.dispose()
    expect(inFlight()).toBe(true)
  })

  it.each(['stopped', 'archived', 'timed out', 'deleted', 'superseded'])('a worker %s mid-turn is not carried on after a restart', async (reason) => {
    const { bridge, runtimes, ledgerEntries } = setup()
    bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })
    runtimes[0].emit({ kind: 'activity', state: 'working' })
    await bridge.end('s1', reason)
    expect(runtimes[0].interrupts).toBe(1)
    expect((ledgerEntries.get('s1') as unknown as { inFlight?: boolean }).inFlight).toBe(false)
  })

  it('says when no process runs, when one is starting, and when a socket can send', async () => {
    const { bridge } = setup({ transcript: true, runtimeOf: 'terminal' })
    const ws = connect(bridge, { readOnly: true })
    await flush()
    expect(ws.events().filter((event) => event.kind === 'process')).toEqual([{ kind: 'process', state: 'stopped' }])
    expect(ws.frames.at(-1)?.type).toBe('joined')
    ws.client({ type: 'start' })
    expect(ws.events().at(-1)).toEqual({ kind: 'process', state: 'starting' })
  })

  it('a message keeps the id the view already shows it under', async () => {
    const { bridge } = setup()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'send', text: 'hi', id: 'local-1' })
    ws.client({ type: 'send', text: 'odd', id: 'not safe!' })
    const ids = ws.events().flatMap((event) => (event.kind === 'user_message' ? [event.id] : []))
    expect(ids[0]).toBe('local-1')
    expect(ids[1]).not.toBe('not safe!')
  })

  it('a tab that comes back while the session closes waits and gets a fresh start, not a dying one', async () => {
    const { bridge, runtimes } = setup()
    const first = connect(bridge)
    await flush()
    first.emit('close')
    const closing = bridge.end('s1', 'timed out')
    const second = connect(bridge)
    await closing
    await flush()
    expect(second.closes).toEqual([])
    expect(runtimes).toHaveLength(2)
    expect(bridge.isRunning('s1')).toBe(true)
  })

  it('a message sent while a view loads does not start a second process', async () => {
    const { bridge, runtimes } = setup({ transcript: true, runtimeOf: 'terminal' })
    const ws = connect(bridge)
    ws.client({ type: 'send', text: 'quick' })
    await flush()
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0].sent).toEqual(['quick'])
  })

  it('a worker that cannot start says why and leaves nothing behind', async () => {
    const failing = setup()
    ;(failing.bridge as unknown as { ctx: { providers: { get: () => unknown } } }).ctx.providers.get = () => ({ runtime: { problem: () => 'no binary' } })
    expect(failing.bridge.startWorker({ id: 's1', projectId: 'p1', prompt: 'x', title: null, fromSessionId: 'r', createdAt: '' })).toBe('no binary')
    expect(failing.bridge.isRunning('s1')).toBe(false)
  })

  it('starts a new session under its id with the session environment, the launch\'s setup-token included', async () => {
    const { bridge, runtimes, ledgerEntries } = setup()
    connect(bridge)
    await flush()
    const { start } = runtimes[0]
    expect(start.resume).toBe(false)
    expect(start.cwd).toBe('/work')
    expect(start.env).toMatchObject({ PROVIDER_VAR: '1', COCKPIT_URL: 'http://host', COCKPIT_SESSION_ID: 's1' })
    // Token mode (Settings › Models): the launch carries it, and the CLI under the SDK signs in with it.
    expect(start.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fake-setup-token')
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
    expect(kinds).toEqual(['user_message', 'history_end', 'notice', 'process'])
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
    const firstSeq = first.seqs()[first.seqs().length - 2]
    first.emit('close')

    const again = connect(bridge, { epoch: reset.epoch, after: firstSeq })
    await flush()
    expect(again.events()).toEqual([{ kind: 'text', blockId: 'b', text: 'two' }])

    const stale = connect(bridge, { epoch: reset.epoch + 100, after: 99 })
    await flush()
    expect(stale.frames[0]).toMatchObject({ type: 'reset' })
    expect(stale.events().filter((event) => event.kind === 'text')).toHaveLength(2)
  })

  it('a second client joins: one runtime, both get every event, and either can send', async () => {
    const { bridge, runtimes } = setup()
    const first = connect(bridge)
    await flush()
    runtimes[0].emit({ kind: 'text', blockId: 'a', text: 'before' })
    const second = connect(bridge)
    await flush()
    expect(first.closes).toEqual([])
    expect(runtimes).toHaveLength(1)
    expect(second.events()).toContainEqual({ kind: 'text', blockId: 'a', text: 'before' })
    second.client({ type: 'send', text: 'from the phone' })
    expect(runtimes[0].sent).toEqual(['from the phone'])
    const user = expect.objectContaining({ kind: 'user_message', text: 'from the phone' })
    expect(first.events()).toContainEqual(user)
    expect(second.events()).toContainEqual(user)
  })

  it('a session is detached only when its last client has left, and ending closes them all', async () => {
    const { bridge } = setup()
    const first = connect(bridge)
    await flush()
    const second = connect(bridge)
    await flush()
    first.emit('close')
    expect(bridge.sessionState('s1')).toBe('running')
    first.readyState = WebSocket.CLOSED
    await bridge.end('s1')
    expect(second.closes).toEqual(['superseded'])
  })

  it('a card answered on one device settles on the other', async () => {
    const { bridge, runtimes } = setup()
    const first = connect(bridge)
    await flush()
    const second = connect(bridge)
    await flush()
    runtimes[0].emit({ kind: 'question', requestId: 'q', questions: [] })
    second.client({ type: 'answer', requestId: 'q', answer: { decision: 'allow' } })
    expect(runtimes[0].answers).toEqual([['q', { decision: 'allow' }]])
    runtimes[0].emit({ kind: 'request_settled', requestId: 'q', outcome: 'allowed' })
    expect(first.events()).toContainEqual({ kind: 'request_settled', requestId: 'q', outcome: 'allowed' })
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

  it('a restart gives the same conversation a new process, and the view stays on it', async () => {
    const { bridge, runtimes, ledgerEntries } = setup({ transcript: true, runtimeOf: 'sdk' })
    const ws = connect(bridge)
    await flush()
    ledgerEntries.get('s1')!.conversation = 'conv-1'
    ws.client({ type: 'restart' })
    await flush()
    expect(runtimes).toHaveLength(2)
    expect(runtimes[0].closed).toBe(true)
    expect(runtimes[1].start.resume).toBe(true)
    expect(runtimes[1].start.conversationId).toBe('conv-1')
    expect(ws.closes).toEqual([])
    expect(ws.events().some((e) => e.kind === 'notice' && e.text === RESTART_NOTICE)).toBe(true)
    ws.client({ type: 'send', text: 'after' })
    expect(runtimes[1].sent).toEqual(['after'])
  })

  it('a restart during a turn stops the turn first, and a message meanwhile is refused, not lost', async () => {
    const { bridge, runtimes, ledgerEntries } = setup({ transcript: true, runtimeOf: 'sdk' })
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'send', text: 'go' })
    ws.client({ type: 'restart' })
    ws.client({ type: 'send', text: 'too early' })
    await flush()
    expect(runtimes[0].interrupts).toBe(1)
    expect(runtimes[0].sent).toEqual(['go'])
    expect(runtimes[1].sent).toEqual([])
    expect(ws.frames.some((f) => f.type === 'error' && /closing/.test(String(f.message)))).toBe(true)
    expect((ledgerEntries.get('s1') as unknown as { inFlight?: boolean }).inFlight).toBe(false)
  })

  it('a restart keeps the session\'s tool profile', async () => {
    const { bridge, runtimes, ledgerEntries } = setup({ transcript: true, runtimeOf: 'sdk' })
    ;(ledgerEntries.get('s1') as unknown as { toolProfile: unknown }).toolProfile = { deniedTools: ['Bash'], mcpServers: null }
    const provider = (bridge as unknown as { ctx: ChatContext }).ctx.providers.get('claude') as unknown as { launch: (req: { toolProfile: unknown }) => unknown }
    const profiles: unknown[] = []
    const launch = provider.launch
    provider.launch = (req) => { profiles.push(req.toolProfile); return launch(req) }
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'restart' })
    await flush()
    expect(runtimes).toHaveLength(2)
    expect(profiles).toEqual([{ deniedTools: ['Bash'], mcpServers: null }, { deniedTools: ['Bash'], mcpServers: null }])
  })

  it('a restart of a session with no process just starts it', async () => {
    const { bridge, runtimes } = setup({ transcript: true, runtimeOf: 'sdk' })
    const ws = connect(bridge, { readOnly: true })
    await flush()
    expect(runtimes).toHaveLength(0)
    ws.client({ type: 'restart' })
    await flush()
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0].start.resume).toBe(true)
  })

  function withJobSession(opts: { limited?: boolean } = {}) {
    const harness = setup({ transcript: true, runtimeOf: 'sdk' })
    const entry = harness.ledgerEntries.get('s1') as unknown as { toolProfile: unknown; jobId: string }
    entry.toolProfile = { deniedTools: ['mcp__gmail__send_email'], mcpServers: null }
    entry.jobId = 'job-1'
    const ledger = (harness.bridge as unknown as { ctx: ChatContext }).ctx.ledger as unknown as Record<string, unknown>
    ledger.clearToolProfile = (id: string) => { (harness.ledgerEntries.get(id) as unknown as { toolProfile: unknown }).toolProfile = null }
    const cleared: string[] = []
    const ctx = (harness.bridge as unknown as { ctx: ChatContext }).ctx
    ctx.jobOf = () => ({ id: 'job-1', name: 'Weekly analysis', limited: opts.limited === true })
    ctx.clearJobProfile = (id) => { cleared.push(id) }
    const profiles: unknown[] = []
    const provider = ctx.providers.get('claude') as unknown as { launch: (req: { toolProfile: unknown }) => unknown }
    const launch = provider.launch
    provider.launch = (req) => { profiles.push(req.toolProfile); return launch(req) }
    return { ...harness, cleared, profiles, entry }
  }

  it('tells the view what the session may not use, and whether the user can lift it', async () => {
    const { bridge } = withJobSession()
    const ws = connect(bridge)
    await flush()
    expect(ws.frames.find((f) => f.type === 'limits')).toEqual({
      type: 'limits', deniedTools: ['mcp__gmail__send_email'], mcpServers: null, job: { id: 'job-1', name: 'Weekly analysis' }, liftable: true,
    })
  })

  it('the user lifts the limits: the restart starts without them, the agent is told, and the job keeps its own unless asked', async () => {
    const { bridge, runtimes, cleared, profiles, entry } = withJobSession()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'restart', unlimited: true })
    await flush()
    expect(entry.toolProfile).toBeNull()
    expect(profiles).toEqual([{ deniedTools: ['mcp__gmail__send_email'], mcpServers: null }, null])
    expect(cleared).toEqual([])
    expect(ws.frames.filter((f) => f.type === 'limits').at(-1)).toMatchObject({ deniedTools: [], liftable: false })
    const shown = ws.events().find((e) => e.kind === 'notice' && /lifted/.test(e.text))
    expect(shown && 'text' in shown ? shown.text : '').toContain('Gmail · Send email')
    expect(runtimes[1].start.worker?.onPrompt()).toContain(liftNotice({ deniedTools: ['mcp__gmail__send_email'], mcpServers: null }, null))
  })

  it('lifting for the job too clears its limits for its future runs', async () => {
    const { bridge, cleared } = withJobSession()
    const ws = connect(bridge)
    await flush()
    ws.client({ type: 'restart', unlimited: true, forJob: true })
    await flush()
    expect(cleared).toEqual(['job-1'])
    // The name is the task's: a schedule sits on a task, there is no job to name.
    expect(ws.events().some((e) => e.kind === 'notice' && /Future runs of the task "Weekly analysis" start without them too\./.test(e.text))).toBe(true)
  })

  it('a limited channel job\'s limits are not lifted here, and nothing restarts', async () => {
    const { bridge, runtimes, entry } = withJobSession({ limited: true })
    const ws = connect(bridge)
    await flush()
    expect(ws.frames.find((f) => f.type === 'limits')).toMatchObject({ liftable: false })
    ws.client({ type: 'restart', unlimited: true })
    await flush()
    expect(entry.toolProfile).not.toBeNull()
    expect(runtimes).toHaveLength(1)
    expect(ws.frames.some((f) => f.type === 'error')).toBe(true)
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

  it('binds the id the agent gave the conversation, and shows no view the event', async () => {
    const { bridge, runtimes } = setup({ transcript: true })
    const ws = connect(bridge)
    await flush()
    const before = ws.events().length
    runtimes[0].emit({ kind: 'conversation', conversationId: 'thread-1' })
    expect(ws.events()).toHaveLength(before)
    runtimes[0].emit({ kind: 'runtime_exit', expected: false })
    ws.client({ type: 'send', text: 'go on' })
    expect(runtimes[1].start).toMatchObject({ resume: true, conversationId: 'thread-1' })
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

  it('waits for a working terminal when asked to, on the same socket, and only then takes over', async () => {
    let busy: 'working' | null = 'working'
    const { bridge, runtimes, terminal } = setup({ terminalRunning: true, busy: () => busy })
    const ws = connect(bridge, { whenIdle: true })
    await flush()
    expect(ws.frames).toEqual([{ type: 'terminal_busy', state: 'working' }])
    expect(terminal.ended).toBe(0)
    expect(runtimes).toHaveLength(0)
    busy = null
    ws.client({ type: 'init', paneId: 'pane', projectId: 'p1', sessionId: 's1', whenIdle: true })
    await flush()
    expect(terminal.ended).toBe(1)
    expect(runtimes).toHaveLength(1)
  })

  it('takes over a working terminal when not asked to wait', async () => {
    const { bridge, runtimes, terminal } = setup({ terminalRunning: true, busy: () => 'working' })
    connect(bridge)
    await flush()
    expect(terminal.ended).toBe(1)
    expect(runtimes).toHaveLength(1)
  })

  it('refuses another agent\'s session', async () => {
    const { bridge } = setup()
    const ws = new FakeSocket()
    bridge.attach(ws as unknown as WebSocket)
    ws.client({ type: 'init', paneId: 'pane', projectId: 'p1', sessionId: 'bad id!' })
    expect(ws.frames[0]).toMatchObject({ type: 'error' })
  })

  it('refuses a session of a provider without a chat, in the words it always had', async () => {
    const { bridge, runtimes } = setup({ provider: 'codex', runtimeOf: 'terminal' })
    const ws = connect(bridge)
    await flush()
    expect(ws.frames[0]).toEqual({ type: 'error', message: 'The chat view runs Claude Code sessions only. This session stays in the terminal.' })
    expect(runtimes).toEqual([])
  })

  it('a new chat runs with the provider its view names, Claude Code when it names none, and a known session keeps its own', async () => {
    const asked: string[] = []
    const named = (init: object, known = false) => {
      const made = setup(known ? { runtimeOf: 'sdk' } : {})
      const providers = (made.bridge as unknown as { ctx: { providers: { get: (id: string) => unknown } } }).ctx.providers
      const get = providers.get
      providers.get = (id) => { asked.push(id); return id === 'nobody' ? undefined : get(id) }
      return { ...made, ws: connect(made.bridge, init) }
    }
    const plain = named({})
    const other = named({ provider: 'codex' })
    const unknown = named({ provider: 'nobody' })
    const known = named({ provider: 'codex' }, true)
    await flush()
    expect(asked).toEqual(['claude', 'codex', 'nobody'])
    expect(plain.runtimes).toHaveLength(1)
    expect(other.runtimes).toHaveLength(1)
    expect(unknown.ws.frames[0]).toEqual({ type: 'error', message: 'This cockpit has no such agent.' })
    expect(unknown.runtimes).toEqual([])
    expect(known.runtimes).toHaveLength(1)
  })

  it('refuses a session the ledger keeps in another space, and starts nothing', async () => {
    const { bridge, runtimes, ledgerEntries } = setup({ transcript: true })
    ledgerEntries.set('s1', { runtime: 'terminal', keepRunning: false, spaceId: 'team' } as never)
    const ws = connect(bridge)
    await flush()
    expect(ws.frames[0]).toEqual({ type: 'error', message: 'This session moved to team. Open it there.' })
    expect(runtimes).toEqual([])
  })
})

describe('parseAnswer', () => {
  it('takes known decisions and drops the rest', async () => {
    expect(parseAnswer({ decision: 'allow' })).toEqual({ decision: 'allow' })
    expect(parseAnswer({ decision: 'answer', answers: { a: 'b', c: 1 } })).toEqual({ decision: 'answer', answers: { a: 'b' } })
    expect(parseAnswer({ decision: 'yolo' })).toBeNull()
    expect(parseAnswer(null)).toBeNull()
  })
})
