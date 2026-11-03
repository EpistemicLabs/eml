import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import {
  CLOSE, applyMembership, checkWrappedKey, encodeFrame, genesisMembers, loginChallenge, openRecord, parseClientFrame, verifyLogin,
  type LoginChallenge, type MemberSet, type RelayFrame,
} from '@engramprotocol/protocol'

// A relay for the sync tests, in-process on a random port: the session, the
// log and wrapped keys of PROTOCOL.md §13 for one brain — create with a grant,
// login, subscribe with backlog and live push, append with seq/at and the
// idempotent resend, key_put, keys and the key push. The real relay (eml-ops)
// checks much more; the tests steer this one (refuse, hold or drop an append,
// close a session).

interface Entry { seq: number, at: string, opId: string, bytes: string, record: Record<string, unknown> }
interface Session { ws: WebSocket, device: string | null, subscribed: boolean }

/** The one grant this relay accepts for a creation. */
export const GRANT = 'grant-for-the-test-relay'

export class FakeRelay {
  readonly log: Entry[] = []
  private set: MemberSet | null = null
  private readonly wrapped: Array<{ recipient: string, record: unknown }> = []
  private readonly sessions = new Set<Session>()
  private clock = Date.parse('2026-10-28T09:00:00.000Z')
  /** the next append is refused with this error */
  refuseNext: { code: 'refused' | 'quota_exceeded', message: string } | null = null
  /** appends are taken but not answered and not pushed (a relay that hangs) */
  hold = false
  /** the next append is taken, then the session closes before the answer goes out */
  dropNextAnswer = false
  /** the session closes on the next append, before it is taken */
  dropNextAppend = false
  /** the op_id of every append frame received, resends included */
  readonly appends: string[] = []
  /** every create frame received: its grant */
  readonly creates: string[] = []
  /** every key_put taken: the recipient */
  readonly keyPuts: string[] = []

  private constructor(private readonly wss: WebSocketServer, readonly brain: string, genesis: Record<string, unknown> | undefined) {
    if (genesis) this.found(genesis)
    wss.on('connection', (ws) => this.session(ws))
  }

  /** A relay holding `brain` with `genesis` — or, without one, a relay that does not have the brain yet (create). */
  static async start(brain: string, genesis?: Record<string, unknown>): Promise<FakeRelay> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => wss.once('listening', () => resolve()))
    return new FakeRelay(wss, brain, genesis)
  }

  get host(): string {
    return `127.0.0.1:${(this.wss.address() as AddressInfo).port}`
  }

  get origin(): string {
    return `ws://${this.host}`
  }

  /** The member set at the head, once the brain exists. */
  get members(): MemberSet | null {
    return this.set
  }

  /** A record some other device appended: stored and pushed to every subscribed session. */
  inject(record: Record<string, unknown>): void {
    this.push(this.store(record))
  }

  /** A wrapped key for `recipient`, kept and pushed to its sessions. */
  putKey(recipient: string, record: unknown): void {
    this.wrapped.push({ recipient, record })
    for (const s of this.sessions) if (s.device === recipient) this.send(s, { t: 'key', wrapped: record as Record<string, unknown> })
  }

  /** Closes every session with `code`. */
  closeAll(code = 1001): void {
    for (const s of this.sessions) s.ws.close(code)
  }

  async stop(): Promise<void> {
    for (const s of this.sessions) s.ws.terminate()
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
  }

  private found(genesis: Record<string, unknown>): void {
    this.set = genesisMembers(openRecord(genesis, this.brain, () => undefined))
    this.store(genesis)
  }

  private session(ws: WebSocket): void {
    const s: Session = { ws, device: null, subscribed: false }
    this.sessions.add(s)
    ws.on('close', () => this.sessions.delete(s))
    const issued = loginChallenge(this.host, this.brain, this.now())
    const challenge: LoginChallenge & { used: boolean } = { ...issued, used: false }
    this.send(s, { t: 'challenge', challenge: issued as unknown as Record<string, unknown> })
    ws.on('message', (data) => {
      const frame = parseClientFrame(String(data), s.device !== null)
      switch (frame.t) {
        case 'create': {
          this.creates.push(frame.grant)
          if (this.set) return this.send(s, { t: 'error', req: null, code: 'brain_exists', message: 'the brain exists' })
          if (frame.grant !== GRANT) return this.send(s, { t: 'error', req: null, code: 'grant_invalid', message: 'the grant is not good for this brain' })
          try {
            this.found(frame.genesis)
          } catch (err) {
            return this.send(s, { t: 'error', req: null, code: 'refused', message: (err as Error).message })
          }
          this.send(s, { t: 'created', seq: 1, at: this.log[0].at })
          return
        }
        case 'login': {
          if (!this.set) {
            this.send(s, { t: 'error', req: null, code: 'unknown_brain', message: 'the relay has no such brain' })
            return ws.close(CLOSE.login_failed)
          }
          let who: { member: string, device: string }
          try {
            who = verifyLogin(this.set, challenge, frame.response, this.now())
          } catch {
            this.send(s, { t: 'error', req: null, code: 'login_failed', message: 'the login failed' })
            return ws.close(CLOSE.login_failed)
          }
          challenge.used = true
          s.device = who.device
          const head = this.log[this.log.length - 1]
          this.send(s, { t: 'welcome', member: who.member, device: who.device, head: { seq: head.seq, at: head.at } })
          return
        }
        case 'keys':
          this.send(s, { t: 'keys', req: frame.req, wrapped: this.wrapped.filter(w => w.recipient === s.device).map(w => w.record as Record<string, unknown>) })
          return
        case 'key_put': {
          let wrapped
          try {
            wrapped = checkWrappedKey(this.set!, frame.wrapped)
          } catch (err) {
            return this.send(s, { t: 'error', req: frame.req, code: 'refused', message: (err as Error).message })
          }
          if (wrapped.wrapper !== s.device) return this.send(s, { t: 'error', req: frame.req, code: 'forbidden', message: 'a key is put by the device that wrapped it' })
          this.keyPuts.push(wrapped.recipient)
          this.send(s, { t: 'ok', req: frame.req })
          this.putKey(wrapped.recipient, frame.wrapped)
          return
        }
        case 'subscribe':
          for (const e of this.log.slice(frame.from - 1)) this.send(s, { t: 'op', seq: e.seq, at: e.at, record: e.record })
          this.send(s, { t: 'caught_up', seq: this.log.length })
          s.subscribed = true
          return
        case 'append': {
          this.appends.push(String(frame.record.op_id))
          if (this.dropNextAppend) {
            this.dropNextAppend = false
            ws.close(1001)
            return
          }
          const bytes = JSON.stringify(frame.record)
          const known = this.log.find(e => e.opId === frame.record.op_id)
          if (known) {
            if (known.bytes === bytes) this.send(s, { t: 'appended', req: frame.req, seq: known.seq, at: known.at })
            else this.send(s, { t: 'error', req: frame.req, code: 'duplicate_op', message: 'the op_id is in the log with other bytes' })
            return
          }
          if (this.refuseNext) {
            this.send(s, { t: 'error', req: frame.req, ...this.refuseNext })
            this.refuseNext = null
            return
          }
          const entry = this.store(frame.record)
          if (this.hold) return
          if (this.dropNextAnswer) {
            this.dropNextAnswer = false
            ws.close(1001)
            return
          }
          this.send(s, { t: 'appended', req: frame.req, seq: entry.seq, at: entry.at })
          this.push(entry)
          return
        }
        default:
          return
      }
    })
  }

  private store(record: Record<string, unknown>): Entry {
    if (record.kind === 'clear' && this.log.length > 0) this.set = applyMembership(this.set!, openRecord(record, this.brain, () => undefined))
    const entry = { seq: this.log.length + 1, at: this.now(), opId: String(record.op_id), bytes: JSON.stringify(record), record }
    this.log.push(entry)
    return entry
  }

  private push(entry: Entry): void {
    for (const s of this.sessions) if (s.subscribed) this.send(s, { t: 'op', seq: entry.seq, at: entry.at, record: entry.record })
  }

  private send(s: Session, frame: RelayFrame): void {
    s.ws.send(encodeFrame(frame, s.device !== null))
  }

  private now(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }
}
