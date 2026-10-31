import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import './setup-home.js'
import { ChatBridge, parseAnswer, type ChatContext } from '../src/chat-bridge.js'
import { InMemoryEventStore } from '../src/application/session-events.js'
import { SessionHandoff } from '../src/application/session-handoff.js'
import type { PermissionAnswer, RuntimeEvent, SessionRuntime, SessionRuntimeFactory, SessionRuntimeStart } from '../src/domain/session-runtime.js'

/**
 * The bridge against a harness that has nothing to do with Claude: no message ids,
 * no blocks, no permission suggestions. If the port were Claude-shaped this adapter
 * could not exist.
 */
class FakeRuntime implements SessionRuntime {
  sent: string[] = []
  answers: Array<[string, PermissionAnswer]> = []
  interrupts = 0
  closed = false
  constructor(readonly start: SessionRuntimeStart) {}
  emit(event: RuntimeEvent): void { this.start.onEvent(event) }
  send(_id: string, text: string): void { this.sent.push(text) }
  async interrupt(): Promise<void> { this.interrupts += 1; this.emit({ kind: 'turn_end', reason: 'interrupted' }) }
  answerPermission(requestId: string, answer: PermissionAnswer): void { this.answers.push([requestId, answer]) }
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
  const ledgerEntries = new Map<string, { runtime: string; keepRunning: boolean }>()
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
      ref: () => ({ sessionId: 's1', providerSessionId: null, projectPath: null, greeted: null }),
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
