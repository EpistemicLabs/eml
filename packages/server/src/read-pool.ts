import * as fs from 'fs'
import * as path from 'path'
import { Worker } from 'worker_threads'
import type { ReadAnswer } from './reads'
import { thrown, type ReadJob, type ReadReply } from './read-worker'
import { commandStatus } from './write'

// --- The read pool ----------------------------------------------------------------------
//
// The server answers every brain from one thread, and better-sqlite3 is
// synchronous: a read that takes seconds (a hygiene sweep, a large list) holds
// up every request of every brain for that long — the log-head watch, the task
// board, the agents' writes. The reads whose cost grows with the brain
// (reads.ts) therefore run here, in a few worker threads with read-only
// connections of their own; writes and the small reads stay on the request
// thread, which keeps the writes in one order.
//
// - Workers start with the first job, up to `size`.
// - Jobs wait in a queue, first come first served. A `slow` job (a sweep that
//   takes seconds) may hold all workers but one, so a quick read never waits
//   for the sweeps to end.
// - A worker that cannot start or dies is replaced, and its job runs on the
//   request thread instead (`inline`). After
//   MAX_FAILED_STARTS deaths in a row the pool stops starting workers and every
//   job runs inline.
// - A job that takes longer than `timeoutMs` ends its worker and is refused
//   (ReadTimeoutError): running it again on the request thread would block it
//   for as long.

/** How many workers a server starts unless EML_READ_WORKERS says otherwise. */
export const READ_WORKERS = 2
/** How long a job may run before its worker is ended. */
export const READ_TIMEOUT_MS = 120_000
const MAX_FAILED_STARTS = 3

/** A read that ran longer than the pool allows. */
export class ReadTimeoutError extends Error {
  constructor(kind: string, ms: number) {
    super(`The ${kind} read took longer than ${Math.round(ms / 1000)} s and was stopped`)
    this.name = 'ReadTimeoutError'
  }
}

/**
 * What a read threw, in a worker or inline: the same message either way, and the
 * code of a rejected command (core CommandError), for the route's error handling.
 */
export class ReadError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'ReadError'
  }
}

/**
 * How the route answers a read that failed in the pool: a read stopped for
 * running too long is a 503 the caller may try again, a read core rejected is
 * answered as the command error it was. Null for anything else — the route's
 * own handling reads its message (a validation text is a 400, the rest a 500).
 */
export function readFailure(err: unknown): { status: number, body: { error: string, code?: string } } | null {
  if (err instanceof ReadTimeoutError) return { status: 503, body: { error: err.message, code: 'READ_TIMEOUT' } }
  if (err instanceof ReadError && err.code) return { status: commandStatus(err.code), body: { error: err.message } }
  return null
}

export interface ReadPoolOptions {
  /** Run a job on the calling thread: the fallback, and all there is when the pool has no workers. */
  inline: (job: ReadJob) => ReadAnswer
  /** How many workers; 0 runs every job inline. */
  size?: number
  /** The worker's script; null when there is none (every job runs inline). Default: the built read-worker next to this file. */
  workerFile?: string | null
  timeoutMs?: number
  log?: (line: string) => void
}

interface Pending {
  job: ReadJob
  slow: boolean
  timeoutMs: number
  resolve: (answer: ReadAnswer) => void
  reject: (err: Error) => void
}

interface Slot {
  worker: Worker
  /** The job it runs; null while it waits for one. */
  running: Pending | null
  timer: ReturnType<typeof setTimeout> | null
  /** True once it answered a job: a worker that dies before that counts as a failed start. */
  proven: boolean
}

/** The built worker in `dir` (default: next to this file): read-worker.js (tsc) or read-worker.cjs (a bundle); null where there is none — a source checkout that is not built, or a bundle shipped without it. */
export function defaultWorkerFile(dir: string = __dirname): string | null {
  return ['read-worker.js', 'read-worker.cjs'].map((name) => path.join(dir, name)).find((file) => fs.existsSync(file)) ?? null
}

export class ReadPool {
  private readonly inline: (job: ReadJob) => ReadAnswer
  private readonly size: number
  private readonly workerFile: string | null
  private readonly timeoutMs: number
  private readonly log: (line: string) => void
  private readonly slots = new Set<Slot>()
  private readonly queue: Pending[] = []
  private failedStarts = 0
  private closed = false

  constructor(opts: ReadPoolOptions) {
    this.inline = opts.inline
    this.workerFile = opts.workerFile === undefined ? defaultWorkerFile() : opts.workerFile
    this.size = this.workerFile === null ? 0 : Math.max(0, Math.floor(opts.size ?? READ_WORKERS))
    this.timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS
    this.log = opts.log ?? (() => {})
  }

  /** True while jobs go to workers; false when every job runs on the calling thread. */
  get threaded(): boolean {
    return !this.closed && this.size > 0 && this.failedStarts < MAX_FAILED_STARTS
  }

  /** Run `job`; `slow` marks one that takes seconds (it leaves a worker free for the quick ones), `timeoutMs` gives it its own limit. */
  run(job: ReadJob, opts: { slow?: boolean, timeoutMs?: number } = {}): Promise<ReadAnswer> {
    return new Promise((resolve, reject) => {
      const pending: Pending = { job, slow: opts.slow === true, timeoutMs: opts.timeoutMs ?? this.timeoutMs, resolve, reject }
      if (!this.threaded) return this.runInline(pending)
      this.queue.push(pending)
      this.drain()
    })
  }

  /** End every worker; jobs still waiting or running are refused. */
  async close(): Promise<void> {
    this.closed = true
    const gone = new Error('The server is shutting down')
    for (const pending of this.queue.splice(0)) pending.reject(gone)
    const slots = [...this.slots]
    this.slots.clear()
    await Promise.all(slots.map((slot) => {
      if (slot.timer) clearTimeout(slot.timer)
      slot.running?.reject(gone)
      slot.running = null
      return slot.worker.terminate()
    }))
  }

  private runInline(pending: Pending): void {
    try {
      pending.resolve(this.inline(pending.job))
    } catch (err) {
      const { error, code } = thrown(err)
      pending.reject(new ReadError(error, code))
    }
  }

  /** All workers but one may run slow jobs; a pool of one runs them too. */
  private get slowMax(): number {
    return Math.max(1, this.size - 1)
  }

  /** Hand waiting jobs to free workers, starting workers while there are fewer than `size`. */
  private drain(): void {
    if (!this.threaded) {
      for (const pending of this.queue.splice(0)) this.runInline(pending)
      return
    }
    for (;;) {
      const slowRunning = [...this.slots].filter((s) => s.running?.slow).length
      const next = this.queue.findIndex((p) => !p.slow || slowRunning < this.slowMax)
      if (next === -1) return
      const slot = [...this.slots].find((s) => s.running === null) ?? this.start()
      if (!slot) return
      const [pending] = this.queue.splice(next, 1)
      slot.running = pending
      slot.timer = setTimeout(() => this.timedOut(slot), pending.timeoutMs)
      slot.timer.unref?.()
      slot.worker.ref()
      slot.worker.postMessage(pending.job)
    }
  }

  private start(): Slot | null {
    if (this.slots.size >= this.size) return null
    let worker: Worker
    try {
      // execArgv: none — what the server was started with (the cockpit host's --import of its watchdog) is not for a worker
      worker = new Worker(this.workerFile!, { execArgv: [] })
    } catch (err) {
      this.failed(null, `could not start (${(err as Error).message})`)
      return null
    }
    const slot: Slot = { worker, running: null, timer: null, proven: false }
    this.slots.add(slot)
    worker.on('message', (reply: ReadReply) => {
      const pending = slot.running
      // an idle worker keeps no process alive
      worker.unref()
      if (slot.timer) clearTimeout(slot.timer)
      slot.running = null
      slot.timer = null
      slot.proven = true
      this.failedStarts = 0
      if (pending) {
        if (reply.ok) pending.resolve(reply.answer)
        else pending.reject(new ReadError(reply.error, reply.code))
      }
      this.drain()
    })
    worker.on('error', (err) => this.failed(slot, `failed (${err.message})`))
    worker.on('exit', (code) => this.failed(slot, `ended (exit code ${code})`))
    return slot
  }

  /** A worker that could not start or is gone: its job runs inline, the next job starts another worker. */
  private failed(slot: Slot | null, why: string): void {
    if (slot && !this.slots.delete(slot)) return // already handled (error, then exit), or ended by the pool itself
    if (slot?.timer) clearTimeout(slot.timer)
    if (this.closed) return
    if (!slot?.proven) this.failedStarts++
    this.log(`[read-pool] a read worker ${why}; ${this.threaded ? 'its read runs on the request thread' : 'reads run on the request thread from now on'}`)
    const pending = slot?.running ?? null
    if (slot) slot.running = null
    if (pending) this.runInline(pending)
    this.drain()
  }

  private timedOut(slot: Slot): void {
    const pending = slot.running
    if (!this.slots.delete(slot)) return
    slot.running = null
    void slot.worker.terminate()
    if (!pending) return
    this.log(`[read-pool] a ${pending.job.kind} read ran longer than ${Math.round(pending.timeoutMs / 1000)} s; its worker was stopped`)
    pending.reject(new ReadTimeoutError(pending.job.kind, pending.timeoutMs))
    this.drain()
  }
}
