import type Database from 'better-sqlite3'
import {
  ProtocolError, checkpointArgs, encodeFrame, fingerprint, loginResponse, memberOfDevice, openAccept, openRecord, parseRelayFrame, sealOp, syncPath,
  type ClientFrame, type Provenance, type RelayFrame, type Role, type RotationAhead, type TeamOp,
} from '@engramprotocol/protocol'
import { CURRENT_BRAIN_SCHEMA_VERSION, CommandError, NO_ACTOR, type CommandMap, type CommandName, type Env } from '@engramprotocol/core'
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
//
// A brain being created (§5; its team file carries the genesis and the grant)
// sends them before the login: the relay creates the brain, the device logs
// in, takes the genesis back through the log like any entry, and puts its
// epoch-0 key for itself. What the relay has taken is dropped from the team
// file as it goes, so a restart continues where it stopped; a relay that has
// the brain already is just logged in to.
//
// A brain being joined (§5; its team file carries the join with its link)
// sends the join before the login and waits for the inviter's accept; with
// the accept in hand it logs in on a new connection — again and again until
// the owner's add_member is in the log and the login goes through — takes
// its first key from the inviter's device only, and replays the log from 1.
// The invite closing under it (taken, cancelled, expired) stops the brain.
//
// Checkpoints (§10, spec §5): a sealed `brain.checkpoint` states the hash of
// the state after its author's head; it counts when it lands right after
// that head, so checkpoint() tries again when another write came in between
// (three attempts). Every device writes one by itself once the log grew by
// CHECKPOINT_EVERY entries since the last one; the inviter writes one before
// it accepts a join (the membership flows call checkpoint()).

export type SyncState =
  /** not connected: connecting, or waiting to reconnect */
  | { kind: 'offline' }
  /** logged in, taking the log up to the relay's head */
  | { kind: 'catching_up' }
  | { kind: 'live' }
  /** an entry waits for the key of its epoch */
  | { kind: 'waiting_key', epoch: number }
  /**
   * joining: `relay` — the relay has not answered the join; `accept` — it holds
   * the join, the inviter has not accepted; `membership` — accepted, the login
   * waits for the owner's add_member; `key` — logged in, the brain key the
   * inviter wrapped for this device is not in yet
   */
  | { kind: 'joining', waiting: 'relay' | 'accept' | 'membership' | 'key' }
  /** `relay`: what the relay answered, when it stopped the brain (a creation it refused) */
  | { kind: 'stopped', why: string, relay?: { code: string, message: string } }
  | { kind: 'update_needed', why: string }

/** A device writes a checkpoint by itself once the log grew by this many entries since the last one. */
export const CHECKPOINT_EVERY = 200

export interface SyncOptions {
  /** how long a write waits for its entry (ms); default 30 s */
  deadlineMs?: number
  /** entries between the checkpoints a device writes by itself; default CHECKPOINT_EVERY */
  checkpointEvery?: number
  /** the first and the longest pause before a reconnect (ms); default 1 s and 60 s */
  backoffMs?: [number, number]
  /** keeps the team file as a creation or join advances (the server writes it to disk); a Sync without one keeps nothing */
  persist?: (file: TeamFile) => void
}

/** A submitted op's entry as the replica took it: the command's result and its seq. */
interface Landed { result: unknown, seq: number }

/** A member as GET /team shows it: who they are in the log, never a key. */
export interface MemberView {
  /** the member's identity key, base64url */
  id: string
  fingerprint: string
  /** null while this device cannot open it (no key of its epoch yet) */
  handle: string | null
  role: Role
  devices: number
  /** this device's member */
  self: boolean
}

/**
 * The shared brain as the host shows it (GET /team; spec
 * team-brain-membership-flows-spec §2): its state, the one text a write would
 * get while it takes none, its member, and the member set in join order.
 */
export interface TeamSnapshot {
  shared: true
  brain: string
  relay: string
  mode: 'create' | 'join' | 'member'
  state: SyncState
  /** the 503 SHARED_BRAIN_READ_ONLY text a write gets right now; null when the brain is live */
  read_only: string | null
  member: MemberView | null
  members: MemberView[]
  /** open invites this device made — the membership flows' (block 2); none yet */
  invites: never[]
}

interface Writer {
  resolve(landed: Landed): void
  reject(err: Error): void
  timer: NodeJS.Timeout
}

type Halt = Extract<SyncState, { kind: 'stopped' | 'update_needed' }>
type Request = { kind: 'keys' } | { kind: 'append', opId: string } | { kind: 'key_put' }

export class Sync {
  /** `create` for a Sync started with a creation to send, `join` with a join under way; `member` otherwise */
  readonly mode: 'create' | 'join' | 'member'
  private readonly replica: Replica
  private readonly url: string
  private readonly host: string
  private readonly deadlineMs: number
  private readonly checkpointEvery: number
  private readonly backoff: [number, number]
  private readonly persist: (file: TeamFile) => void
  private ws: WebSocket | null = null
  private loggedIn = false
  private caughtUp = false
  /** the challenge of this connection, held while the creation goes first */
  private challenge: unknown = null
  /** the relay answered brain_exists to the creation: the login decides whether the brain is this device's */
  private existed = false
  /** the relay holds this connection's join and waits for the accept with it */
  private joinWaiting = false
  /** the seq the subscription started from */
  private from = 0
  /** delivered entries the replica has not taken yet, in order */
  private queue: Array<{ seq: number, at: string, record: unknown }> = []
  private nextReq = 1
  /** answers awaited: a keys request, a key_put, or an append (by op_id) */
  private requests = new Map<number, Request>()
  /** writes whose entry has not arrived, by op_id */
  private writers = new Map<string, Writer>()
  /** wrapped keys the replica cannot take yet: before the genesis, or for the next epoch before its rotation is in the log */
  private pendingKeys: unknown[] = []
  /** sealed records the relay has not acknowledged yet — resent byte-identical after a reconnect */
  private unconfirmed = new Map<string, Record<string, unknown>>()
  /** the key_put the relay has not answered */
  private keyPut: number | null = null
  /** entries in the log since the last checkpoint that counts (or the genesis) */
  private sinceCheckpoint: number
  /** a checkpoint of this device is on its way */
  private checkpointing = false
  /** callers of whenLive */
  private waiters: Array<(state: SyncState) => void> = []
  private halt: Halt | null = null
  private closed = false
  private delay: number
  private retry: NodeJS.Timeout | null = null

  constructor(db: Database.Database, readonly team: TeamFile, opts: SyncOptions = {}) {
    this.mode = team.create ? 'create' : team.join || team.accept ? 'join' : 'member'
    this.replica = new Replica(db, team)
    this.url = `${team.relay}${syncPath(team.brain)}`
    this.host = new URL(team.relay).host
    this.deadlineMs = opts.deadlineMs ?? 30_000
    this.checkpointEvery = opts.checkpointEvery ?? CHECKPOINT_EVERY
    this.sinceCheckpoint = Math.max(0, this.replica.head().seq - this.replica.lastCheckpointSeq())
    this.backoff = opts.backoffMs ?? [1_000, 60_000]
    this.persist = opts.persist ?? (() => undefined)
    this.delay = this.backoff[0]
  }

  get state(): SyncState {
    const replica = this.replica.state
    if (replica.kind === 'stopped' || replica.kind === 'update_needed') return replica
    if (this.halt) return this.halt
    if (this.team.join) return { kind: 'joining', waiting: this.joinWaiting ? 'accept' : 'relay' }
    if (this.team.accept) return { kind: 'joining', waiting: this.loggedIn ? 'key' : 'membership' }
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
    this.settleWaiters()
  }

  /**
   * Resolves once the brain is live, or when it stopped (with that state),
   * or once the relay has its join or the inviter's accept, or — after the
   * write deadline — with the state as it is then; never rejects. What a
   * route waits on after starting a creation or a join.
   */
  whenLive(): Promise<SyncState> {
    const now = this.state
    if (now.kind === 'live' || now.kind === 'stopped' || now.kind === 'update_needed' || this.closed) return Promise.resolve(now)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== settle)
        resolve(this.state)
      }, this.deadlineMs)
      const settle = (state: SyncState) => { clearTimeout(timer); resolve(state) }
      this.waiters.push(settle)
    })
  }

  /** The handle the log binds to this device's member, once the log says. */
  ownHandle(): string | null {
    return this.replica.ownHandle()
  }

  /** Why a write would be refused in `state` — the 503 a write gets — or null when the brain takes writes. */
  private readOnlyFor(state: SyncState): SharedWriteError | null {
    if (state.kind !== 'stopped' && state.kind !== 'update_needed' && state.kind !== 'joining' && this.replica.head().seq === 0) return readOnly('it is not created yet')
    if (state.kind !== 'live') return readOnly(reason(state), state.kind === 'stopped' || state.kind === 'update_needed')
    if (!this.replica.currentKey()) return readOnly('this device has no key for it yet')
    if (this.replica.ownHandle() === null) return readOnly('this device\'s member has no handle in it')
    return null
  }

  /** The brain as the host shows it (GET /team): state, the read-only text a write would get, its member and the member set. */
  snapshot(): TeamSnapshot {
    const state = this.state
    const set = this.replica.members()
    const own = set ? memberOfDevice(set, this.team.device.sign.publicKey) : undefined
    const members: MemberView[] = set
      ? Object.entries(set.members).map(([id, m]) => ({
        id, fingerprint: fingerprint(id), handle: this.replica.handleOf(id), role: m.role, devices: Object.keys(m.devices).length, self: id === own,
      }))
      : []
    return {
      shared: true,
      brain: this.team.brain,
      relay: this.team.relay,
      mode: this.mode,
      state,
      read_only: this.readOnlyFor(state)?.message ?? null,
      member: members.find(m => m.self) ?? null,
      members,
      invites: [],
    }
  }

  /** Closes the connection and the brain file: the brain is discarded (DELETE /team, a creation the relay never took). */
  discard(): void {
    this.close()
    this.replica.close()
  }

  /**
   * A confirmed write: the command as an op of this device's member, sealed
   * under the current key and appended; resolves with the command's result
   * once the replica took its entry, or throws what the brain or the relay
   * said. Read-only unless the brain is live. `deadlineMs` for this one write
   * when it carries more than a usual one (a project move's import).
   */
  async write<N extends CommandName>(command: { name: N, input: CommandMap[N][0] }, env: Env, opts: { deadlineMs?: number } = {}): Promise<CommandMap[N][1]> {
    const refusal = this.readOnlyFor(this.state)
    if (refusal) throw refusal
    // the member's handle, as the log binds it; the agent as the host stamped it (x-eml-agent)
    const landed = await this.submit(command.name, command.input, { ...env.actor, handle: this.replica.ownHandle() as string }, env.newId(), opts.deadlineMs)
    return landed.result as CommandMap[N][1]
  }

  /**
   * A checkpoint: the hash of the brain's state after this device's head,
   * sealed and appended (PROTOCOL.md §10). It counts only right after that
   * head, so when another write came in between it is written again at the
   * new head — three attempts, then SharedWriteError CHECKPOINT_NOT_ADJACENT.
   * Resolves with the seq of the entry that counts. Read-only unless the
   * brain is live, as a write.
   */
  checkpoint(): Promise<{ seq: number }> {
    return this.writeCheckpoint(false)
  }

  /** The attempts of checkpoint(); `auto` is the policy's own, which gives up once another device's checkpoint counted meanwhile. */
  private async writeCheckpoint(auto: boolean): Promise<{ seq: number }> {
    this.checkpointing = true
    try {
      for (let attempt = 1; ; attempt++) {
        const refusal = this.readOnlyFor(this.state)
        if (refusal) throw refusal
        const head = this.replica.head()
        const landed = await this.submit('brain.checkpoint', checkpointArgs(head.seq, this.replica.stateHash()), { ...NO_ACTOR, handle: this.replica.ownHandle() as string }, crypto.randomUUID())
        if (landed.seq === head.seq + 1) return { seq: landed.seq }
        if (auto && this.sinceCheckpoint < this.checkpointEvery) return { seq: landed.seq - this.sinceCheckpoint }
        if (attempt >= 3) {
          throw new SharedWriteError(409, 'CHECKPOINT_NOT_ADJACENT',
            'The checkpoint did not land right after the state it names; other writes came in between. Try again.')
        }
      }
    } finally {
      this.checkpointing = false
    }
  }

  /** The policy: a checkpoint by this device once the log grew by checkpointEvery entries, while live and none of its own on the way. */
  private autoCheckpoint(): void {
    if (this.checkpointing || this.sinceCheckpoint < this.checkpointEvery || this.state.kind !== 'live') return
    this.writeCheckpoint(true).catch((err: unknown) => {
      // by code only: a relay's text never reaches the log unsanitized
      this.log(`the automatic checkpoint did not land (${(err as { code?: string }).code ?? 'error'})`)
    })
  }

  /**
   * An op of this device's member — `call` with `args` — sealed under the
   * current key and appended; resolves once the replica took its entry, with
   * the result and the seq, or throws what the brain or the relay said.
   */
  private submit(call: string, args: unknown, provenance: Provenance, opId: string, deadlineMs = this.deadlineMs): Promise<Landed> {
    const key = this.replica.currentKey()
    if (!key) throw readOnly('this device has no key for it yet')
    const head = this.replica.head()
    const op: TeamOp = {
      op_id: opId,
      schema: CURRENT_BRAIN_SCHEMA_VERSION,
      call,
      args: args as never,
      provenance,
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
      }, deadlineMs)
      this.writers.set(op.op_id, { resolve, reject, timer })
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
    try {
      this.handle(frame)
    } finally {
      this.settleWaiters()
    }
  }

  private handle(frame: RelayFrame): void {
    switch (frame.t) {
      case 'challenge':
        this.challenge = frame.challenge
        // a creation goes first: the relay has no brain to log in to yet
        if (this.team.create) return this.send({ t: 'create', genesis: this.team.create.genesis, grant: this.team.create.grant }, false)
        // a join too: this device is no member to log in as yet
        if (this.team.join) return this.send({ t: 'join', join: this.team.join.request as unknown as Record<string, unknown> }, false)
        return this.login()
      case 'join_waiting':
        this.joinWaiting = true
        this.delay = this.backoff[0]
        return
      case 'accept':
        return this.accepted(frame.accept)
      case 'invite_closed':
        return this.inviteClosed(frame.reason)
      case 'created':
        if (!this.took('create')) return
        return this.login()
      case 'welcome': {
        this.loggedIn = true
        this.delay = this.backoff[0]
        // the brain exists at the relay and this device is its member's: the creation is over
        if (this.team.create && !this.took('create')) return
        if (frame.head.seq < this.replica.head().seq) return this.stop('the relay\'s log is shorter than this brain\'s')
        const req = this.nextReq++
        this.requests.set(req, { kind: 'keys' })
        this.send({ t: 'keys', req })
        return
      }
      case 'keys': {
        this.requests.delete(frame.req)
        for (const wrapped of frame.wrapped) this.addKey(wrapped)
        this.publishKey()
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
        this.autoCheckpoint()
        return
      case 'appended': {
        const asked = this.requests.get(frame.req)
        this.requests.delete(frame.req)
        if (asked?.kind === 'append') this.unconfirmed.delete(asked.opId)
        return
      }
      case 'ok': {
        const asked = this.requests.get(frame.req)
        this.requests.delete(frame.req)
        if (asked?.kind === 'key_put') {
          this.keyPut = null
          this.took('key')
        }
        return
      }
      case 'error':
        return this.failed(frame)
      default:
        // a join pushed to the inviter's device: the membership flows'
        return
    }
  }

  /** The inviter's accept of this device's join: checked under the invite secret, kept; the login follows on a new connection. */
  private accepted(value: unknown): void {
    const join = this.team.join
    if (!join) return
    let opened
    try {
      opened = openAccept(join.link, join.request, value)
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err
      this.log(`an accept that does not answer this device's join: ${err.message}`)
      return
    }
    this.team.accept = { inviter: opened.inviter, anchor: opened.anchor }
    delete this.team.join
    if (!this.kept(() => { this.team.join = join; delete this.team.accept })) return
    this.joinWaiting = false
    this.delay = this.backoff[0]
    this.ws?.close()  // an invitee logs in on a new connection
  }

  /** The invite closed before the inviter accepted: the brain stops; `unknown` when the relay has no open invite with this id. */
  private inviteClosed(reason: string): void {
    this.halted({ kind: 'stopped', why: `its invite was closed (${reason})`, relay: { code: 'invite_closed', message: reason } })
  }

  /** An error frame: the answer to a request, to the creation, or the relay's own. */
  private failed(frame: Extract<RelayFrame, { t: 'error' }>): void {
    const asked = frame.req === null ? undefined : this.requests.get(frame.req)
    if (frame.req !== null) this.requests.delete(frame.req)
    const message = untrusted(frame.message)
    if (frame.code === 'unsupported_version') return this.updateNeeded('the relay speaks a newer protocol')
    if (asked?.kind === 'append') {
      this.unconfirmed.delete(asked.opId)
      this.settleError(asked.opId, new SharedWriteError(409, 'SHARED_WRITE_REFUSED',
        `The shared brain's relay refused this write (${frame.code}): ${message}. Nothing was written.`))
      return
    }
    if (asked?.kind === 'key_put') {
      this.keyPut = null
      this.log(`the relay did not keep this device's key (${frame.code}): ${message}`)
      return
    }
    if (!this.loggedIn && this.team.join) {
      // the answer to the join
      if (frame.code === 'invite_closed') return this.inviteClosed('unknown')
      if (frame.code === 'rate_limited') return  // the relay closes; the join is sent again after the pause
      return this.halted({ kind: 'stopped', why: `the relay did not take the join (${frame.code}): ${message}`, relay: { code: frame.code, message } })
    }
    if (!this.loggedIn && this.team.accept && frame.code === 'login_failed') return  // not a member yet: the login is tried again
    if (!this.loggedIn && this.team.create) {
      // the answer to the creation
      if (frame.code === 'brain_exists' && !this.existed) {
        this.existed = true
        return this.login()
      }
      const relay = { code: frame.code, message }
      if (frame.code === 'grant_invalid') return this.halted({ kind: 'stopped', why: `the relay did not accept the creation grant: ${message}`, relay })
      if (frame.code === 'login_failed' && this.existed) return this.halted({ kind: 'stopped', why: 'the relay has a brain with this id that this device is no member of', relay: { code: 'brain_exists', message } })
      return this.halted({ kind: 'stopped', why: `the relay did not create the brain (${frame.code}): ${message}`, relay })
    }
    this.log(`relay error ${frame.code}: ${message}`)
  }

  private login(): void {
    let response
    try {
      response = loginResponse(this.challenge, this.host, this.team.brain, this.team.device.sign)
    } catch (err) {
      this.log(`login challenge refused: ${(err as Error).message}`)
      this.ws?.close()
      return
    }
    this.send({ t: 'login', response: response as unknown as Record<string, unknown> }, false)
  }

  /**
   * The relay took what `section` of the team file held for it: dropped from
   * the file. False when the file could not be written — the brain stops,
   * since a restart would send it again as if the relay had not.
   */
  private took(section: 'create' | 'key' | 'accept'): boolean {
    if (!this.team[section]) return true
    const kept = this.team[section]
    delete this.team[section]
    return this.kept(() => { this.team[section] = kept as never })
  }

  /** Writes the team file as it is now; on failure `undo` restores it and the brain stops (see took). */
  private kept(undo: () => void): boolean {
    try {
      this.persist(this.team)
      return true
    } catch (err) {
      undo()
      this.log(`the team file could not be written: ${(err as Error).message}`)
      this.stop('its team file could not be written')
      return false
    }
  }

  /** Puts the key this device holds itself (a created brain's epoch-0 key) at the relay, once the genesis is in. */
  private publishKey(): void {
    if (!this.team.key || !this.loggedIn || this.keyPut !== null) return
    let wrapped
    try {
      wrapped = this.replica.takeOwnKey(this.team.key)
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err
      return  // before the genesis: again once it is in
    }
    const req = this.nextReq++
    this.requests.set(req, { kind: 'key_put' })
    this.keyPut = req
    this.send({ t: 'key_put', req, wrapped: wrapped as unknown as Record<string, unknown> })
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
      if (entry.seq === 1) this.publishKey()
      // the genesis states the hash of the state it starts from: a checkpoint too
      this.sinceCheckpoint = entry.seq === 1 || (outcome.kind === 'applied' && outcome.checkpoint) ? 0 : this.sinceCheckpoint + 1
      const opId = (entry.record as { op_id?: unknown }).op_id
      if (typeof opId === 'string') {
        this.unconfirmed.delete(opId)  // its entry is in the log, whether the relay's answer came or not
        this.settle(opId, outcome, entry.seq)
      }
    }
    this.autoCheckpoint()
  }

  private settle(opId: string, outcome: Extract<Outcome, { kind: 'applied' | 'rejected' }>, seq: number): void {
    const writer = this.writers.get(opId)
    if (!writer) return
    this.writers.delete(opId)
    clearTimeout(writer.timer)
    if (outcome.kind === 'applied') writer.resolve({ result: outcome.result, seq })
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

  /** Tells whoever waits for the brain to be live once it is, once it stopped, or once its join got past the relay. */
  private settleWaiters(): void {
    if (this.waiters.length === 0) return
    const state = this.state
    const joined = state.kind === 'joining' && state.waiting !== 'relay'
    if (state.kind !== 'live' && state.kind !== 'stopped' && state.kind !== 'update_needed' && !joined && !this.closed) return
    const waiters = this.waiters
    this.waiters = []
    for (const settle of waiters) settle(state)
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

  /** A device that joined takes its first key from the inviter's device only; the accept is done with once it has. */
  private tryKey(wrapped: unknown): boolean {
    try {
      this.replica.addKey(wrapped, this.team.accept?.inviter, this.team.accept ? this.rotationsAhead() : [])
      if (this.team.accept) this.took('accept')
      return true
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err
      return false
    }
  }

  /**
   * The rotations the delivered entries not taken yet name, in order: what a
   * joining device reads ahead to open a key of a later epoch than its
   * replica has reached (PROTOCOL.md §8). Clear records open without a key;
   * one that does not open is left to the replica to refuse in its turn.
   */
  private rotationsAhead(): RotationAhead[] {
    const ahead: RotationAhead[] = []
    for (const entry of this.queue) {
      if ((entry.record as { kind?: unknown } | null)?.kind !== 'clear') continue
      try {
        const opened = openRecord(entry.record, this.team.brain, () => undefined)
        if (opened.envelope.call === 'team.rotate_key') ahead.push(opened.envelope.args as unknown as RotationAhead)
      } catch (err) {
        if (!(err instanceof ProtocolError)) throw err
      }
    }
    return ahead
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
    this.challenge = null
    this.joinWaiting = false
    this.queue = []
    this.requests.clear()
    this.keyPut = null
    if (code === 4004) return this.stop('this device or its member left the brain')
    if (code === 4001) return this.updateNeeded('the relay speaks a newer protocol')
    if (this.closed || this.halt) return this.settleWaiters()
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
    this.settleWaiters()
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
    case 'joining': return 'it is still joining its team brain'
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

/** A text the relay sent, as it may be logged or shown: no control characters, at most 200 characters. */
export function untrusted(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 200)
}
