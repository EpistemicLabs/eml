import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppServerSpawn } from '../../src/infrastructure/providers/codex/chat-runtime.js'

/**
 * `codex app-server` without the CLI, for the tests of the Codex chat runtime: a process
 * that is none, answering what a session asks of it from the recordings in
 * fixtures/codex-app-server. A test changes an answer with `answer`, and says what the
 * server would say on its own with `notify` and `ask`.
 */

interface Line {
  dir: 'in' | 'out'
  msg: { id?: number; method?: string; params?: unknown; result?: unknown }
}

export const recorded = (name: string): Line[] => readFileSync(join(__dirname, '..', 'fixtures', 'codex-app-server', name), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Line)

/** The recorded answer to the client's request of this method. */
function recordedResult(file: string, method: string): unknown {
  const lines = recorded(file)
  const request = lines.find((line) => line.dir === 'out' && line.msg.method === method)
  return lines.find((line) => line.dir === 'in' && !line.msg.method && line.msg.id === request?.msg.id)?.msg.result
}

export class RefusedRequest extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

type Answer = (params: Record<string, unknown>) => unknown

export class FakeAppServer extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4242
  exited = false
  /** What the session's process was started with. */
  spawned: AppServerSpawn | null = null
  /** Every message the client wrote, in order. */
  received: Array<{ id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }> = []
  /** A turn ends by itself as soon as it started; off: the test ends it (`completeTurn`). */
  turnsEnd = true
  private answers = new Map<string, Answer>()
  private turns = 0
  private requests = 0
  private buffer = ''

  stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      this.buffer += chunk
      for (;;) {
        const end = this.buffer.indexOf('\n')
        if (end < 0) return
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        if (line) this.take(JSON.parse(line) as FakeAppServer['received'][number])
      }
    },
    // Like the real server: gone once its stdin closes.
    end: () => { queueMicrotask(() => this.exit(0)) },
  })

  constructor(readonly threadId = '01a2180d-3336-79a0-a84b-0d4746f780ec') {
    super()
    // The recorded thread ran in the sandbox; one started without it reports that.
    const thread = (id: string, params: Record<string, unknown>) => {
      const started = recordedResult('turn-approval.jsonl', 'thread/start') as { thread: { id: string } }
      return { ...started, thread: { ...started.thread, id }, ...(params.sandbox === 'danger-full-access' ? { sandbox: { type: 'dangerFullAccess' } } : {}) }
    }
    this.answer('initialize', () => recordedResult('handshake.jsonl', 'initialize'))
    this.answer('model/list', () => recordedResult('handshake.jsonl', 'model/list'))
    this.answer('thread/start', (params) => thread(this.threadId, params))
    this.answer('thread/resume', (params) => thread(params.threadId as string, params))
    this.answer('turn/start', () => {
      const turn = { id: `turn-${++this.turns}`, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null }
      queueMicrotask(() => {
        this.notify('thread/status/changed', { threadId: this.threadId, status: { type: 'active', activeFlags: [] } })
        this.notify('turn/started', { threadId: this.threadId, turn })
        if (this.turnsEnd) this.completeTurn()
      })
      return { turn }
    })
    this.answer('turn/interrupt', () => {
      queueMicrotask(() => this.completeTurn('interrupted'))
      return {}
    })
    this.answer('thread/turns/list', () => { throw new RefusedRequest(-32600, 'thread not found') })
  }

  /** What the server answers a request of this method with from now on; a RefusedRequest thrown is its error. */
  answer(method: string, answer: Answer): void {
    this.answers.set(method, answer)
  }

  private take(message: FakeAppServer['received'][number]): void {
    this.received.push(message)
    if (message.method === undefined || message.id === undefined) return
    const { id, method } = message
    queueMicrotask(() => {
      try {
        const answer = this.answers.get(method)
        if (!answer) throw new RefusedRequest(-32601, `unknown method ${method}`)
        this.say({ id, result: answer(message.params ?? {}) })
      } catch (error) {
        if (!(error instanceof RefusedRequest)) throw error
        this.say({ id, error: { code: error.code, message: error.message } })
      }
    })
  }

  private say(message: unknown): void {
    if (!this.exited) this.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`))
  }

  notify(method: string, params: unknown): void {
    this.say({ method, params })
  }

  /** The server asks the client something; returns the id its answer comes back under. */
  ask(method: string, params: unknown): number {
    const id = this.requests++
    this.say({ id, method, params })
    return id
  }

  /** The running turn ends. */
  completeTurn(status: 'completed' | 'interrupted' | 'failed' = 'completed', error: { message: string } | null = null): void {
    this.notify('thread/status/changed', { threadId: this.threadId, status: { type: 'idle' } })
    this.notify('turn/completed', { threadId: this.threadId, turn: { id: `turn-${this.turns}`, items: [], itemsView: 'notLoaded', status, error } })
  }

  /** The client's requests of one method, as their params. */
  requestsOf(method: string): Array<Record<string, unknown>> {
    return this.received.filter((message) => message.method === method && message.id !== undefined).map((message) => message.params ?? {})
  }

  /** The texts of the turns the client started, one entry per turn, its input items joined. */
  turnTexts(): string[][] {
    return this.requestsOf('turn/start').map((params) => (params.input as Array<{ type: string; text?: string }>).map((item) => item.text ?? `[${item.type}]`))
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, signal)
  }

  kill(signal?: NodeJS.Signals): boolean {
    queueMicrotask(() => this.exit(null, signal ?? 'SIGTERM'))
    return true
  }
}

/** A spawn that hands out fake servers and keeps them, newest last. */
export function fakeSpawn(configure: (server: FakeAppServer) => void = () => {}) {
  const servers: FakeAppServer[] = []
  const spawn = (options: AppServerSpawn) => {
    const server = new FakeAppServer()
    server.spawned = options
    configure(server)
    servers.push(server)
    return server
  }
  return { spawn, servers }
}
