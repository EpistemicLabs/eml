import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import {
  CLOSE, applyMembership, canonicalJson, checkAccept, checkJoin, checkWrappedKey, encodeFrame, genesisMembers, loginChallenge, openRecord, parseClientFrame, verifyInviteNotice, verifyLogin,
  type InviteClosedReason, type InviteNotice, type JoinAccept, type JoinRequest, type LoginChallenge, type MemberSet, type RelayFrame,
} from '@engramprotocol/protocol'

// A relay for the sync tests, in-process on a random port: the session, the
// log and wrapped keys of PROTOCOL.md §13 for one brain — create with a grant,
// login, subscribe with backlog and live push, append with seq/at and the
// idempotent resend, key_put, keys and the key push, and the invitee's side
// of §8 — a join against a notice the test opened, join_waiting, the accept
// the test gives, invite_closed — and the inviter's side: invite_put,
// invite_cancel, invite_accept, the join pushed to the inviter's device (live,
// and pending ones after its login). The real relay (eml-ops) checks much
// more; the tests steer this one (refuse, hold or drop an append, close a
// session).

interface Entry { seq: number, at: string, opId: string, bytes: string, record: Record<string, unknown> }
interface Session { ws: WebSocket, device: string | null, subscribed: boolean, waitingOn: string | null, silent: boolean }
interface OpenInvite { notice: InviteNotice, join: JoinRequest | null, accept: JoinAccept | null, closed: InviteClosedReason | null }

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
  /** keys requests are taken but not answered until releaseKeys() (a relay that answers late) */
  holdKeys = false
  private readonly heldKeys: Array<() => void> = []
  /** every keys request received */
  keysRequests = 0
  /** every subscribe received */
  subscribes = 0
  /** the op_id of every append frame received, resends included */
  readonly appends: string[] = []
  /** runs when an append arrives, before it is taken, with its count (a test slips another device's record in) */
  onAppend: ((count: number) => void) | null = null
  /** every create frame received: its grant */
  readonly creates: string[] = []
  /** every key_put taken: the recipient */
  readonly keyPuts: string[] = []
  /** every join frame received: the join's canonical text */
  readonly joins: string[] = []
  /** every invite_put taken: the invite id */
  readonly invitePuts: string[] = []
  /** every invite_accept taken: the invite id */
  readonly accepts: string[] = []
  private readonly invites = new Map<string, OpenInvite>()

  private constructor(private readonly wss: WebSocketServer, readonly brain: string, genesis: Record<string, unknown> | undefined) {
    if (genesis) this.found(genesis)
    wss.on('connection', (ws) => this.session(ws))
  }

  /** A relay holding `brain` with `genesis` — or, without one, a relay that does not have the brain yet (create). `port`: a fixed one, for a relay that comes back where it was. */
  static async start(brain: string, genesis?: Record<string, unknown>, port = 0): Promise<FakeRelay> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port })
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

  /** An invite an owner put: a join is checked against its notice. */
  openInvite(notice: InviteNotice): void {
    this.invites.set(notice.invite_id, { notice, join: null, accept: null, closed: null })
  }

  /** The join the invite holds, once an invitee sent one. */
  joinOf(inviteId: string): JoinRequest | null {
    return this.invites.get(inviteId)?.join ?? null
  }

  /** The inviter's accept: kept, pushed to every session waiting on the invite. A second, different accept is refused like the real relay does. */
  acceptJoin(accept: JoinAccept): void {
    const invite = this.invites.get(accept.invite_id)
    if (!invite?.join) throw new Error('the invite has no join yet')
    const checked = checkAccept(accept, invite.join)
    if (invite.accept && canonicalJson(invite.accept) !== canonicalJson(checked)) throw new Error('the invite has another accept')
    invite.accept = checked
    this.accepts.push(accept.invite_id)
    for (const s of this.sessions) if (s.waitingOn === accept.invite_id) this.send(s, { t: 'accept', accept: { ...accept } })
  }

  /** The invite's notice, as the relay keeps it. */
  noticeOf(inviteId: string): InviteNotice | null {
    return this.invites.get(inviteId)?.notice ?? null
  }

  /** The invite closes (cancelled, expired): every session waiting on it hears so. */
  closeInvite(inviteId: string, reason: InviteClosedReason): void {
    const invite = this.invites.get(inviteId)
    if (invite) invite.closed = reason
    for (const s of this.sessions) if (s.waitingOn === inviteId) this.send(s, { t: 'invite_closed', invite_id: inviteId, reason })
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
    const s: Session = { ws, device: null, subscribed: false, waitingOn: null, silent: false }
    this.sessions.add(s)
    ws.on('close', () => this.sessions.delete(s))
    const issued = loginChallenge(this.host, this.brain, this.now())
    const challenge: LoginChallenge & { used: boolean } = { ...issued, used: false }
    this.send(s, { t: 'challenge', challenge: issued as unknown as Record<string, unknown> })
    ws.on('message', (data) => {
      if (s.silent) return
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
        case 'join': {
          this.joins.push(canonicalJson(frame.join))
          const inviteId = (frame.join as { invite_id?: unknown }).invite_id
          const invite = typeof inviteId === 'string' ? this.invites.get(inviteId) : undefined
          if (!invite) return this.send(s, { t: 'error', req: null, code: 'invite_closed', message: 'there is no open invite with this id' })
          let join: JoinRequest
          try {
            join = checkJoin(frame.join, invite.notice)
          } catch (err) {
            return this.send(s, { t: 'error', req: null, code: 'refused', message: (err as Error).message })
          }
          if (invite.closed) return this.send(s, { t: 'invite_closed', invite_id: invite.notice.invite_id, reason: invite.closed })
          if (invite.join && canonicalJson(invite.join) !== canonicalJson(join)) return this.send(s, { t: 'invite_closed', invite_id: invite.notice.invite_id, reason: 'taken' })
          const first = invite.join === null
          invite.join = join
          s.waitingOn = invite.notice.invite_id
          this.send(s, { t: 'join_waiting', invite_id: invite.notice.invite_id })
          if (invite.accept) this.send(s, { t: 'accept', accept: { ...invite.accept } })
          if (first) for (const o of this.sessions) if (o.device === invite.notice.inviter) this.send(o, { t: 'join', join: { ...join } })
          return
        }
        case 'login': {
          if (s.waitingOn !== null) return this.send(s, { t: 'error', req: null, code: 'forbidden', message: 'an invitee logs in on a new connection' })
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
          // the joins waiting for this device's accept
          for (const invite of this.invites.values()) {
            if (invite.notice.inviter === who.device && invite.join && !invite.accept && !invite.closed) this.send(s, { t: 'join', join: { ...invite.join } })
          }
          return
        }
        case 'invite_put': {
          let notice: InviteNotice
          try {
            notice = verifyInviteNotice(this.set!, frame.notice, new Date().toISOString())  // the real relay checks against its real clock
          } catch (err) {
            return this.send(s, { t: 'error', req: frame.req, code: 'refused', message: (err as Error).message })
          }
          if (notice.inviter !== s.device) return this.send(s, { t: 'error', req: frame.req, code: 'forbidden', message: 'an invite is put by the device that signed it' })
          this.openInvite(notice)
          this.invitePuts.push(notice.invite_id)
          return this.send(s, { t: 'ok', req: frame.req })
        }
        case 'invite_cancel': {
          const invite = this.invites.get(frame.invite_id)
          if (!invite) return this.send(s, { t: 'error', req: frame.req, code: 'refused', message: 'there is no such invite' })
          this.send(s, { t: 'ok', req: frame.req })
          this.closeInvite(frame.invite_id, 'cancelled')
          return
        }
        case 'invite_accept': {
          const inviteId = (frame.accept as { invite_id?: unknown }).invite_id
          const invite = typeof inviteId === 'string' ? this.invites.get(inviteId) : undefined
          if (!invite || invite.closed) return this.send(s, { t: 'error', req: frame.req, code: 'refused', message: 'there is no open invite with this id' })
          if (invite.notice.inviter !== s.device) return this.send(s, { t: 'error', req: frame.req, code: 'forbidden', message: 'an accept comes from the device that made the invite' })
          try {
            this.acceptJoin(frame.accept as unknown as JoinAccept)
          } catch (err) {
            return this.send(s, { t: 'error', req: frame.req, code: 'refused', message: (err as Error).message })
          }
          return this.send(s, { t: 'ok', req: frame.req })
        }
        case 'keys': {
          this.keysRequests += 1
          const answer = () => this.send(s, { t: 'keys', req: frame.req, wrapped: this.wrapped.filter(w => w.recipient === s.device).map(w => w.record as Record<string, unknown>) })
          if (this.holdKeys) this.heldKeys.push(answer)
          else answer()
          return
        }
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
          this.subscribes += 1
          for (const e of this.log.slice(frame.from - 1)) this.send(s, { t: 'op', seq: e.seq, at: e.at, record: e.record })
          this.send(s, { t: 'caught_up', seq: this.log.length })
          s.subscribed = true
          return
        case 'append': {
          this.appends.push(String(frame.record.op_id))
          this.onAppend?.(this.appends.length)
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
    if (s.silent || s.ws.readyState !== s.ws.OPEN) return
    s.ws.send(encodeFrame(frame, s.device !== null))
  }

  /** The sessions open now go dead without a close: nothing in, nothing out, the sockets stay (a laptop that slept, a network that went away). New connections work. */
  silence(): void {
    for (const s of this.sessions) s.silent = true
  }

  /** Answers the keys requests held back since holdKeys was set, in order. */
  releaseKeys(): void {
    for (const answer of this.heldKeys.splice(0)) answer()
  }

  private now(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }
}
