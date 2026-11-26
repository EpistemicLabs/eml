import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import './setup-home.js'
import type { SessionRef } from '../src/domain/agent-provider.js'
import type { ModeOption, RuntimeEvent, SessionRuntime, SessionRuntimeFactory, SessionRuntimeStart } from '../src/domain/session-runtime.js'

/**
 * What every chat runtime owes the bridge (domain/session-runtime.ts), checked for each
 * adapter the same way and as far as it goes without a model: what a start says and in
 * which order, where a message goes, how a permission is settled, how a run ends, and what
 * the history of a conversation it never stored is. What only one adapter does is in its
 * own test (chat-agent, claude-sdk-mapping).
 *
 * Two events of a session's log are not a runtime's: the bridge writes `process` before it
 * starts one and `user_message` when it sends (chat-bridge.ts). A runtime that sent them
 * too would show both twice.
 *
 * A new runtime is one more entry in SUBJECTS: its factory, and its harness driven by hand.
 */

/** The harness behind a factory, as a test drives it in place of the agent CLI. */
interface Harness {
  factory: SessionRuntimeFactory
  /** The messages the harness took from send(), as text, in order. */
  received(): string[]
  /** The harness asks for a permission in the session started last. */
  ask(): void
  /** The process of the session started last ends on its own. */
  die(): void
}

interface Subject {
  name: string
  create(): Promise<Harness>
}

/** The Agent SDK's queries in this file, newest last: Claude Code's runtime without its CLI. */
const sdk = vi.hoisted(() => ({
  queries: [] as Array<{ options: Record<string, unknown>; taken: unknown[]; end(): void }>,
}))

// Only `query` is replaced: it answers what a start asks of it and ends when it is closed.
// Reading a stored conversation stays the SDK's own.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    let end: () => void = () => {}
    const ended = new Promise<void>((resolve) => { end = resolve })
    const taken: unknown[] = []
    void (async () => { for await (const message of params.prompt) taken.push(message) })()
    sdk.queries.push({ options: params.options, taken, end })
    return {
      // No messages: the process runs until it is closed, or ends on its own.
      async *[Symbol.asyncIterator]() { await ended },
      close: end,
      interrupt: async () => {},
      initializationResult: async () => ({ models: [{ value: 'default', displayName: 'Default', description: 'The default model' }], commands: [] }),
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 200_000 }),
    }
  },
}))

const MEMORY_MODES: ModeOption[] = [
  { id: 'ask', label: 'Ask first', description: 'Asks before it changes anything' },
  { id: 'alone', label: 'Alone', description: 'Asks nobody' },
]

/** A runtime with nothing behind it: the least an adapter has to do. */
function memoryHarness(): Harness {
  const received: string[] = []
  let requests = 0
  let last: { ask(): void; exit(expected: boolean): void } | null = null
  const factory: SessionRuntimeFactory = {
    workerMode: 'alone',
    start(request) {
      const emit = request.onEvent
      const open = new Set<string>()
      let exited = false
      const exit = (expected: boolean) => {
        if (exited) return
        exited = true
        for (const requestId of open) emit({ kind: 'request_settled', requestId, outcome: 'cancelled' })
        open.clear()
        emit({ kind: 'runtime_exit', expected })
      }
      // Ready a moment after the start, as a process is.
      queueMicrotask(() => {
        if (exited) return
        emit({ kind: 'capabilities', modes: MEMORY_MODES, models: [] })
        emit({ kind: 'settings', mode: request.mode ?? 'ask' })
      })
      last = {
        ask: () => {
          const requestId = `r${++requests}`
          open.add(requestId)
          emit({ kind: 'permission_request', requestId, toolId: null, toolName: 'Shell', title: 'Run ls', input: { command: 'ls' }, reason: null, alwaysScope: null })
        },
        exit,
      }
      const runtime: SessionRuntime = {
        send: (_id, text) => { received.push(text) },
        interrupt: async () => {},
        answerPermission: (requestId, answer) => {
          if (!open.delete(requestId)) return
          const outcome = answer.decision === 'deny' ? 'denied' : answer.decision === 'answer' ? 'answered' : answer.decision === 'always' ? 'always' : 'allowed'
          emit({ kind: 'request_settled', requestId, outcome })
        },
        setMode: async (mode) => emit({ kind: 'settings', mode }),
        setModel: async (model) => emit({ kind: 'settings', model }),
        stopAgent: async () => {},
        toolServers: async () => [],
        setToolServerEnabled: async () => {},
        reconnectToolServer: async () => {},
        close: async () => exit(true),
      }
      return runtime
    },
    history: async () => [{ kind: 'history_end' }],
  }
  return { factory, received: () => received, ask: () => last?.ask(), die: () => last?.exit(false) }
}

/** Claude Code's runtime on the query above. */
async function claudeHarness(): Promise<Harness> {
  const { createClaudeSdkRuntimes } = await import('../src/infrastructure/providers/claude/sdk-runtime.js')
  const first = sdk.queries.length
  const mine = () => sdk.queries.slice(first)
  const textOf = (message: unknown) => (message as { message: { content: string } }).message.content
  return {
    factory: createClaudeSdkRuntimes(),
    received: () => mine().flatMap((query) => query.taken.map(textOf)),
    ask: () => {
      const canUseTool = mine().at(-1)?.options.canUseTool as (name: string, input: object, options: object) => Promise<unknown>
      void canUseTool('Bash', { command: 'ls' }, { toolUseID: `t${randomUUID()}`, signal: new AbortController().signal, suggestions: [] })
    },
    die: () => mine().at(-1)?.end(),
  }
}

const SUBJECTS: Subject[] = [
  { name: 'a runtime in memory', create: async () => memoryHarness() },
  { name: 'Claude Code (Agent SDK, without its CLI)', create: claudeHarness },
]

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)) }

/** A session's start as the bridge asks for it, its events collected. */
function started(harness: Harness, over: Partial<SessionRuntimeStart> = {}): { runtime: SessionRuntime; events: RuntimeEvent[] } {
  const events: RuntimeEvent[] = []
  const runtime = harness.factory.start({
    sessionId: randomUUID(), resume: false, conversationId: null, mode: null, model: null, cwd: '/work', env: {}, address: 'session-address',
    launch: { bin: 'agent', args: [], env: {}, keepRunning: false },
    space: { id: 'space', mcpToken: 't', files: { mcpConfig: '/m.json', settings: '/s.json', emlConfig: '/e' } },
    onEvent: (event) => events.push(event),
    ...over,
  })
  return { runtime, events }
}

const kinds = (events: RuntimeEvent[]) => events.map((event) => event.kind)
const modesOf = (events: RuntimeEvent[]) => events.flatMap((event) => (event.kind === 'capabilities' ? event.modes.map((mode) => mode.id) : []))
const modeOf = (events: RuntimeEvent[]) => events.flatMap((event) => (event.kind === 'settings' && event.mode ? [event.mode] : [])).at(-1)

/** The contract itself: everything in it holds for any factory. */
function sessionRuntimeContract({ create }: Subject): void {
  it('a start says what can be chosen, the worker\'s mode among it, and then what it runs with', async () => {
    const harness = await create()
    const { runtime, events } = started(harness)
    await flush()
    expect(kinds(events)).toContain('capabilities')
    expect(modesOf(events)).toContain(harness.factory.workerMode)
    // `capabilities` says the session is ready: its settings come after it, and name a mode it offers.
    expect(kinds(events).lastIndexOf('settings')).toBeGreaterThan(kinds(events).indexOf('capabilities'))
    expect(modesOf(events)).toContain(modeOf(events))
    expect(kinds(events)).not.toContain('process')
    expect(kinds(events)).not.toContain('runtime_exit')
    await runtime.close()
  })

  it('a session started in the worker\'s mode runs in it', async () => {
    const harness = await create()
    const { runtime, events } = started(harness, { mode: harness.factory.workerMode })
    await flush()
    expect(modeOf(events)).toBe(harness.factory.workerMode)
    await runtime.close()
  })

  it('a message reaches the harness, in order, and is not written into the log a second time', async () => {
    const harness = await create()
    const { runtime, events } = started(harness)
    runtime.send('m1', 'first')
    runtime.send('m2', 'second')
    await flush()
    expect(harness.received()).toEqual(['first', 'second'])
    expect(kinds(events)).not.toContain('user_message')
    await runtime.close()
  })

  it('a permission is settled by its first answer, and an answer to no open request does nothing', async () => {
    const harness = await create()
    const { runtime, events } = started(harness)
    await flush()
    harness.ask()
    await flush()
    const asked = events.find((event) => event.kind === 'permission_request')
    if (asked?.kind !== 'permission_request') throw new Error('no permission was asked')
    runtime.answerPermission(asked.requestId, { decision: 'allow' })
    runtime.answerPermission(asked.requestId, { decision: 'deny' })
    runtime.answerPermission('nobody-asked', { decision: 'allow' })
    expect(events.filter((event) => event.kind === 'request_settled')).toEqual([{ kind: 'request_settled', requestId: asked.requestId, outcome: 'allowed' }])
    await runtime.close()
  })

  it('close resolves, settles what is open as cancelled, and the expected exit is the last event', async () => {
    const harness = await create()
    const { runtime, events } = started(harness)
    await flush()
    harness.ask()
    await flush()
    await runtime.close()
    await flush()
    expect(events.filter((event) => event.kind === 'request_settled')).toMatchObject([{ outcome: 'cancelled' }])
    expect(events.filter((event) => event.kind === 'runtime_exit')).toEqual([{ kind: 'runtime_exit', expected: true }])
    expect(events.at(-1)).toEqual({ kind: 'runtime_exit', expected: true })
    // A second close is nothing new.
    await runtime.close()
    await flush()
    expect(events.at(-1)).toEqual({ kind: 'runtime_exit', expected: true })
    expect(events.filter((event) => event.kind === 'runtime_exit')).toHaveLength(1)
  })

  it('a process that ends on its own is an exit nobody expected, said once', async () => {
    const harness = await create()
    const { runtime, events } = started(harness)
    await flush()
    harness.die()
    await flush()
    expect(events.at(-1)).toEqual({ kind: 'runtime_exit', expected: false })
    await runtime.close()
    await flush()
    expect(events.filter((event) => event.kind === 'runtime_exit')).toHaveLength(1)
  })

  it('the history of a conversation it never stored is the end of history, and nothing before it', async () => {
    const { factory } = await create()
    const unknown: SessionRef = { sessionId: randomUUID(), providerSessionId: null, projectPath: '/work', greeted: null }
    expect(await factory.history(unknown)).toEqual([{ kind: 'history_end' }])
    expect(await factory.history({ ...unknown, providerSessionId: randomUUID() })).toEqual([{ kind: 'history_end' }])
  })
}

describe.each(SUBJECTS)('the chat runtime contract: $name', sessionRuntimeContract)
