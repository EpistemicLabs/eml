import type Database from 'better-sqlite3'
import {
  ProtocolError, encodeFrame, loginResponse, parseRelayFrame, sealOp, syncPath,
  type ClientFrame, type RelayFrame, type TeamOp,
} from '@engramprotocol/protocol'
import { CURRENT_BRAIN_SCHEMA_VERSION, CommandError, type CommandMap, type CommandName, type Env } from '@engramprotocol/core'
import { Replica, type Outcome } from './replica'
import type { TeamFile } from './team-file'
import { SharedWriteError, readOnly } from '../write'

// --- A shared brain's connection to its relay (v0.21, spec team-brain-sync-client-spec §4) ---
//
// One per shared brain: a WebSocket to the relay (PROTOCOL.md §13), its own
// connection to the brain file, and the replica on it. It logs in with the
// device key, fetches this device's wrapped keys, subscribes from the head and
// hands every entry to the replica in order. Writes are confirmed: sealed,
// appended, and answered once the replica took the entry the relay gave them.
// A lost connection is retried; until the replica is caught up again the brain
// is read-only.

export type SyncState =
  /** not connected: connecting, or waiting to reconnect */
  | { kind: 'offline' }
  /** logged in, taking the log up to the relay's head */
  | { kind: 'catching_up' }
  | { kind: 'live' }
  /** an entry waits for the key of its epoch */
  | { kind: 'waiting_key', epoch: number }
  | { kind: 'stopped', why: string }
  | { kind: 'update_needed', why: string }

export interface SyncOptions {
  /** how long a write waits for its entry (ms); default 30 s */
  deadlineMs?: number
  /** the first and the longest pause before a reconnect (ms); default 1 s and 60 s */
  backoffMs?: [number, number]
}

interface Writer {
  resolve(result: unknown): void
  reject(err: Error): void
  timer: NodeJS.Timeout
}

type Halt = Extract<SyncState, { kind: 'stopped' | 'update_needed' }>

export class Sync {
  private readonly replica: Replica
  private readonly url: string
  private readonly host: string
  private readonly deadlineMs: number
  private readonly backoff: [number, number]
  private ws: WebSocket | null = null
  private loggedIn = false
  private caughtUp = false
  /** the seq the subscription started from */
  private from = 0
  /** delivered entries the replica has not taken yet, in order */
  private queue: Array<{ seq: number, at: string, record: unknown }> = []
  private nextReq = 1
  /** answers awaited: a keys request, or an append (by op_id) */
  private requests = new Map<number, { kind: 'keys' } | { kind: 'append', opId: string }>()
  /** writes whose entry has not arrived, by op_id */
  private writers = new Map<string, Writer>()
  /** wrapped keys the replica cannot take yet: before the genesis, or for the next epoch before its rotation is in the log */
  private pendingKeys: unknown[] = []
  /** sealed records the relay has not acknowledged yet — resent byte-identical after a reconnect */
  private unconfirmed = new Map<string, Record<string, unknown>>()
  private halt: Halt | null = null
  private closed = false
  private delay: number
  private retry: NodeJS.Timeout | null = null

  constructor(db: Database.Database, private readonly team: TeamFile, opts: SyncOptions = {}) {
    this.replica = new Replica(db, team)
    this.url = `${team.relay}${syncPath(team.brain)}`
    this.host = new URL(team.relay).host
    this.deadlineMs = opts.deadlineMs ?? 30_000
    this.backoff = opts.backoffMs ?? [1_000, 60_000]
    this.delay = this.backoff[0]
  }

  get state(): SyncState {
    const replica = this.replica.state
    if (replica.kind === 'stopped' || replica.kind === 'update_needed') return replica
    if (this.halt) return this.halt
    if (!this.loggedIn) return { kind: 'offline' }
    if (replica.kind === 'waiting') return { kind: 'waiting_key', epoch: replica.epoch }
    if (!this.caughtUp || this.queue.length > 0) return { kind: 'catching_up' }
    return { kind: 'live' }
  }

  start(): void {
    this.connect()
  }

  /** Closes the connection for good (server shutdown); writes still waiting get the may-still-land error. */
  close(): void {
    this.closed = true
    if (this.retry) clearTimeout(this.retry)
    this.ws?.close()
    this.failWriters()
  }

  /**
   * A confirmed write: the command as an op of this device's member, sealed
   * under the current key and appended; resolves with the command's result
   * once the replica took its entry, or throws what the brain or the relay
   * said. Read-only unless the brain is live.
   */
  async write<N extends CommandName>(command: { name: N, input: CommandMap[N][0] }, env: Env): Promise<CommandMap[N][1]> {
    const state = this.state
    if (state.kind !== 'live') throw readOnly(reason(state), state.kind === 'stopped' || state.kind === 'update_needed')
    const key = this.replica.currentKey()
    if (!key) throw readOnly('this device has no key for it yet')
    const handle = this.replica.ownHandle()
    if (handle === null) throw readOnly('this device\'s member has no handle in it')
    const head = this.replica.head()
    const op: TeamOp = {
      op_id: env.newId(),
      schema: CURRENT_BRAIN_SCHEMA_VERSION,
      call: command.name,
      args: command.input as never,
      // the member's handle, as the log binds it; the agent is not stamped yet
      provenance: { ...env.actor, handle, agent: null },
      team: { brain: this.team.brain, device: this.team.device.sign.publicKey, base_seq: head.seq, head_hash: head.hash },
    }
    let record: Record<string, unknown>
    try {
      record = sealOp(op, this.team.device.sign, key).record as unknown as Record<string, unknown>
    } catch (err) {
      if (err instanceof ProtocolError) throw new CommandError('INVALID', `Invalid command: ${err.message}`)
      throw err
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.writers.delete(op.op_id)
        reject(pending())
      }, this.deadlineMs)
      this.writers.set(op.op_id, { resolve: resolve as (r: unknown) => void, reject, timer })
      this.unconfirmed.set(op.op_id, record)
      this.append(op.op_id, record)
    })
  }

  private connect(): void {
    if (this.closed || this.halt || this.replica.state.kind === 'stopped' || this.replica.state.kind === 'update_needed') return
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onmessage = (ev) => { if (this.ws === ws) this.receive(ev.data) }
    ws.onclose = (ev) => { if (this.ws === ws) this.disconnected(ev.code) }
    ws.onerror = () => { /* a close follows */ }
  }

  private receive(data: unknown): void {
    let frame: RelayFrame
    try {
      if (typeof data !== 'string') throw new ProtocolError('a relay frame is text')
      frame = parseRelayFrame(data, this.loggedIn)
    } catch (err) {
      this.log(`malformed frame from the relay: ${(err as Error).message}`)
      this.ws?.close()
      return
    }
    switch (frame.t) {
      case 'challenge': {
        let response
        try {
          response = loginResponse(frame.challenge, this.host, this.team.brain, this.team.device.sign)
        } catch (err) {
          this.log(`login challenge refused: ${(err as Error).message}`)
          this.ws?.close()
          return
        }
        this.send({ t: 'login', response: response as unknown as Record<string, unknown> }, false)
        return
      }
      case 'welcome': {
        this.loggedIn = true
        this.delay = this.backoff[0]
        if (frame.head.seq < this.replica.head().seq) return this.stop('the relay\'s log is shorter than this brain\'s')
        const req = this.nextReq++
        this.requests.set(req, { kind: 'keys' })
        this.send({ t: 'keys', req })
        return
      }
      case 'keys': {
        this.requests.delete(frame.req)
        for (const wrapped of frame.wrapped) this.addKey(wrapped)
        this.from = this.replica.head().seq + 1
        this.send({ t: 'subscribe', from: this.from })
        return
      }
      case 'key':
        this.addKey(frame.wrapped)
        this.process()
        return
      case 'op':
        this.queue.push({ seq: frame.seq, at: frame.at, record: frame.record })
        this.process()
        return
      case 'caught_up':
        if (frame.seq < this.from - 1) return this.stop('the relay\'s log is shorter than this brain\'s')
        this.caughtUp = true
        for (const [opId, record] of this.unconfirmed) this.append(opId, record)
        return
      case 'appended': {
        const asked = this.requests.get(frame.req)
        this.requests.delete(frame.req)
        if (asked?.kind === 'append') this.unconfirmed.delete(asked.opId)
        return
      }
      case 'error': {
        const asked = frame.req === null ? undefined : this.requests.get(frame.req)
        if (frame.req !== null) this.requests.delete(frame.req)
        if (frame.code === 'unsupported_version') return this.updateNeeded('the relay speaks a newer protocol')
        if (asked?.kind === 'append') {
          this.unconfirmed.delete(asked.opId)
          this.settleError(asked.opId, new SharedWriteError(409, 'SHARED_WRITE_REFUSED',
            `The shared brain's relay refused this write (${frame.code}): ${frame.message}. Nothing was written.`))
          return
        }
        this.log(`relay error ${frame.code}: ${frame.message}`)
        return
      }
      default:
        // invites and joins are the membership flows' (block 6)
        return
    }
  }

  /** Hands queued entries to the replica in order, until one waits for a key or the replica stops. */
  private process(): void {
    while (this.queue.length > 0) {
      const entry = this.queue[0]
      const outcome = this.replica.take(entry)
      if (outcome.kind === 'waiting') {
        if (this.retryKeys()) continue
        return
      }
      this.queue.shift()
      this.retryKeys()
      if (outcome.kind === 'stopped' || outcome.kind === 'update_needed') {
        this.log(`${outcome.kind === 'stopped' ? 'stopped' : 'update needed'}: ${outcome.why}`)
        this.ws?.close()
        this.failWriters()
        return
      }
      const opId = (entry.record as { op_id?: unknown }).op_id
      if (typeof opId === 'string') this.settle(opId, outcome)
    }
  }

  private settle(opId: string, outcome: Extract<Outcome, { kind: 'applied' | 'rejected' }>): void {
    const writer = this.writers.get(opId)
    if (!writer) return
    this.writers.delete(opId)
    clearTimeout(writer.timer)
    if (outcome.kind === 'applied') writer.resolve(outcome.result)
    else writer.reject(outcome.error ?? new SharedWriteError(409, 'SHARED_WRITE_REJECTED',
      `The shared brain kept this write as rejected: ${outcome.why}. Nothing changed.`))
  }

  private settleError(opId: string, err: Error): void {
    const writer = this.writers.get(opId)
    if (!writer) return
    this.writers.delete(opId)
    clearTimeout(writer.timer)
    writer.reject(err)
  }

  /** Every write still waiting: it may still land, nobody here will see it. */
  private failWriters(): void {
    for (const opId of [...this.writers.keys()]) this.settleError(opId, pending())
  }

  /** Takes a wrapped key now, or keeps it for when the log has reached what it needs. */
  private addKey(wrapped: unknown): void {
    if (!this.tryKey(wrapped)) this.pendingKeys.push(wrapped)
  }

  /** Tries the kept keys again; true when one was taken. */
  private retryKeys(): boolean {
    const before = this.pendingKeys.length
    this.pendingKeys = this.pendingKeys.filter(wrapped => !this.tryKey(wrapped))
    return this.pendingKeys.length < before
  }

  private tryKey(wrapped: unknown): boolean {
    try {
      this.replica.addKey(wrapped)
      return true
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err
      return false
    }
  }

  private append(opId: string, record: Record<string, unknown>): void {
    if (!this.loggedIn) return  // sent after the next caught_up
    const req = this.nextReq++
    this.requests.set(req, { kind: 'append', opId })
    this.send({ t: 'append', req, record })
  }

  private send(frame: ClientFrame, loggedIn = true): void {
    this.ws?.send(encodeFrame(frame, loggedIn))
  }

  private disconnected(code: number): void {
    this.ws = null
    this.loggedIn = false
    this.caughtUp = false
    this.queue = []
    this.requests.clear()
    if (code === 4004) return this.stop('this device or its member left the brain')
    if (code === 4001) return this.updateNeeded('the relay speaks a newer protocol')
    if (this.closed || this.halt) return
    this.retry = setTimeout(() => { this.retry = null; this.connect() }, this.delay)
    this.delay = Math.min(this.delay * 2, this.backoff[1])
  }

  private stop(why: string): void {
    this.halted({ kind: 'stopped', why })
  }

  private updateNeeded(why: string): void {
    this.halted({ kind: 'update_needed', why })
  }

  private halted(halt: Halt): void {
    this.halt = halt
    this.log(`${halt.kind === 'stopped' ? 'stopped' : 'update needed'}: ${halt.why}`)
    this.ws?.close()
    this.failWriters()
  }

  private log(line: string): void {
    console.error(`[sync] ${this.team.brain}: ${line}`)
  }
}

/** Why a brain in `state` takes no write — the reason in SHARED_BRAIN_READ_ONLY. */
function reason(state: SyncState): string {
  switch (state.kind) {
    case 'offline': return 'it is not connected to its relay'
    case 'catching_up': return 'it is catching up with its relay'
    case 'waiting_key': return 'this device has no key for it yet'
    case 'stopped': return `it stopped: ${state.why}`
    case 'update_needed': return `this cockpit needs an update: ${state.why}`
    case 'live': return 'it is live'
  }
}

/** 504 SHARED_WRITE_PENDING: sent, but its entry did not arrive in time. */
function pending(): SharedWriteError {
  return new SharedWriteError(504, 'SHARED_WRITE_PENDING',
    'The write was sent to the shared brain\'s relay but not confirmed in time; it may still land — check before writing it again.')
}
