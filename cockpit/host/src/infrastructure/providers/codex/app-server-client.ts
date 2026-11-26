import { StringDecoder } from 'node:string_decoder'
import { METHOD_NOT_FOUND, type ClientRequestMethod, type ClientRequests, type RequestId, type RpcError } from './protocol.js'

/**
 * A JSON-RPC client over the stdio of a `codex app-server` process: one JSON object
 * per line, no `"jsonrpc"` field. It pairs requests with their answers and hands on
 * what the server sends on its own; it knows nothing of threads or turns.
 *
 * The process comes from the caller, with its command, folder and environment: none
 * of that is read here, and a test runs it against a process that is none.
 */

// close() ends stdin and the server exits on its own; this is the bound for a
// process that ignores that.
const EXIT_TIMEOUT_MS = 8_000
const STDERR_TAIL = 2_000

/** What the client needs of a child process (a `ChildProcessWithoutNullStreams` is one). */
export interface AppServerProcess {
  stdin: {
    write(chunk: string): unknown
    end(): unknown
    on(event: 'error', listener: (error: Error) => void): unknown
  }
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown }
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown }
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  /** It never started, or could not be reached: no `exit` follows. */
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
  pid?: number
}

/** The server answered a request with an error. */
export class AppServerError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(error: RpcError) {
    super(error.message)
    this.name = 'AppServerError'
    this.code = error.code
    this.data = error.data
  }
}

/** The process ended before the request was answered, or before it was sent. */
export class AppServerExitError extends Error {
  constructor() {
    super('The app-server process has ended.')
    this.name = 'AppServerExitError'
  }
}

export interface AppServerExit {
  /** Null: ended by a signal, or never started. */
  code: number | null
  signal: string | null
  /** After close(): no crash. */
  expected: boolean
}

type NotificationListener = (method: string, params: unknown) => void
type RequestListener = (id: RequestId, method: string, params: unknown) => void
type ExitListener = (exit: AppServerExit) => void

interface Pending {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

export class AppServerClient {
  private process: AppServerProcess
  private pending = new Map<RequestId, Pending>()
  private nextId = 1
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private stderr = ''
  private ended = false
  private closing = false
  private markExited: () => void = () => {}
  private notificationListeners: NotificationListener[] = []
  private requestListeners: RequestListener[] = []
  private exitListeners: ExitListener[] = []

  /** Resolves once the process has ended. */
  readonly exited: Promise<void>

  constructor(spawn: () => AppServerProcess) {
    this.exited = new Promise((resolve) => { this.markExited = resolve })
    this.process = spawn()
    this.process.stdout.on('data', (chunk) => this.read(chunk))
    this.process.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL) })
    // A write to a process that is gone: its exit says so.
    this.process.stdin.on('error', () => {})
    this.process.on('exit', (code, signal) => this.end(code, signal))
    this.process.on('error', () => this.end(null, null))
  }

  get pid(): number | undefined {
    return this.process.pid
  }

  /** The end of what the process wrote to stderr: the reason when it died. */
  stderrTail(): string {
    return this.stderr
  }

  /** Rejects with an AppServerError when the server refuses, with an AppServerExitError when the process ends first. */
  request<M extends ClientRequestMethod>(method: M, params: ClientRequests[M]['params']): Promise<ClientRequests[M]['result']>
  request(method: string, params?: unknown): Promise<unknown>
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.ended) return Promise.reject(new AppServerExitError())
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write(params === undefined ? { id, method } : { id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  /** Every notification of the server, known or not. */
  onNotification(listener: NotificationListener): void {
    this.notificationListeners.push(listener)
  }

  /**
   * A request of the server. The caller answers it by its id with respond() or
   * respondError(), now or much later: an approval waits for the user. With no
   * listener at all a request is refused at once, so the server never waits on nobody.
   */
  onRequest(listener: RequestListener): void {
    this.requestListeners.push(listener)
  }

  onExit(listener: ExitListener): void {
    this.exitListeners.push(listener)
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result })
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } })
  }

  /** Ends the process: stdin closes, and what has not exited by the timeout is killed. Resolves once it is gone. */
  async close(): Promise<void> {
    if (this.ended) return
    if (!this.closing) {
      this.closing = true
      try { this.process.stdin.end() } catch { /* gone */ }
    }
    const timer = setTimeout(() => { try { this.process.kill('SIGKILL') } catch { /* gone */ } }, EXIT_TIMEOUT_MS)
    await this.exited
    clearTimeout(timer)
  }

  private write(message: object): void {
    if (this.ended || this.closing) return
    try { this.process.stdin.write(`${JSON.stringify(message)}\n`) } catch { /* gone: its exit rejects what waits */ }
  }

  /** A chunk ends anywhere, also inside a character: only whole lines are messages. */
  private read(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end < 0) return
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (line) this.receive(line)
    }
  }

  private receive(line: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      message = parsed
    } catch {
      // Not the protocol (a stray log line): nothing to answer.
      return
    }
    const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : null
    if (typeof message.method === 'string') {
      if (id === null) for (const listener of this.notificationListeners) listener(message.method, message.params)
      else if (this.requestListeners.length === 0) this.respondError(id, METHOD_NOT_FOUND, `No handler for ${message.method}`)
      else for (const listener of this.requestListeners) listener(id, message.method, message.params)
      return
    }
    if (id === null) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (message.error !== undefined && message.error !== null) {
      const error = message.error as Partial<RpcError>
      pending.reject(new AppServerError({
        code: typeof error.code === 'number' ? error.code : 0,
        message: typeof error.message === 'string' ? error.message : 'The app-server refused the request.',
        data: error.data,
      }))
    } else {
      pending.resolve(message.result)
    }
  }

  private end(code: number | null, signal: string | null): void {
    if (this.ended) return
    this.ended = true
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const pending of waiting) pending.reject(new AppServerExitError())
    this.markExited()
    for (const listener of this.exitListeners) listener({ code, signal, expected: this.closing })
  }
}
