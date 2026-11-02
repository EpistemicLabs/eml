import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import {
  applyMembership, encodeFrame, genesisMembers, loginChallenge, openRecord, parseClientFrame, verifyLogin,
  type LoginChallenge, type MemberSet, type RelayFrame,
} from '@engramprotocol/protocol'

// A relay for the sync tests, in-process on a random port: the session, the
// log and wrapped keys of PROTOCOL.md §13 for one brain — login, subscribe with
// backlog and live push, append with seq/at and the idempotent resend, keys and
// the key push. The real relay (eml-ops) checks much more; the tests steer this
// one (refuse, hold or drop an append, close a session).

interface Entry { seq: number, at: string, opId: string, bytes: string, record: Record<string, unknown> }
interface Session { ws: WebSocket, device: string | null, subscribed: boolean }

export class FakeRelay {
  readonly log: Entry[] = []
  private set: MemberSet
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

  private constructor(private readonly wss: WebSocketServer, readonly brain: string, genesis: Record<string, unknown>) {
    this.set = genesisMembers(openRecord(genesis, brain, () => undefined))
    this.store(genesis)
    wss.on('connection', (ws) => this.session(ws))
  }

  static async start(brain: string, genesis: Record<string, unknown>): Promise<FakeRelay> {
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
        case 'login': {
          const { member, device } = verifyLogin(this.set, challenge, frame.response, this.now())
          challenge.used = true
          s.device = device
          const head = this.log[this.log.length - 1]
          this.send(s, { t: 'welcome', member, device, head: { seq: head.seq, at: head.at } })
          return
        }
        case 'keys':
          this.send(s, { t: 'keys', req: frame.req, wrapped: this.wrapped.filter(w => w.recipient === s.device).map(w => w.record as Record<string, unknown>) })
          return
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
    if (record.kind === 'clear' && this.log.length > 0) this.set = applyMembership(this.set, openRecord(record, this.brain, () => undefined))
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
