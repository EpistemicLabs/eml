import { INVITE_ID_BYTES } from './invite'
import { ISO_MS, KEY_BYTES, PROTOCOL_VERSION, ProtocolError, UUID, UnsupportedVersionError, asObject, exactFields, fromBase64url, utf8 } from './wire'

// --- Relay transport (v0.21) -----------------------------------------------------
//
// How a device and the relay talk: one WebSocket per device per brain at
// /sync/1/<brain>, text frames of one JSON object each, `{t, …}` with exactly
// the fields of its `t` (spec team-brain-relay-service-spec §3, PROTOCOL.md
// §13). Records, keys, notices, joins and accepts ride inside a frame as they
// are; their own readers (openRecord, unwrapKey, verifyInviteNotice, openJoin,
// openAccept, verifyLogin) check them. A frame is bounded before it is parsed:
// the reader checks its byte length itself, because not every WebSocket client
// can cap what it receives.

/**
 * The largest frame, in bytes of UTF-8: 24 MiB, either way. The largest record
 * is a sealed op at MAX_PAYLOAD — its ciphertext of 64 + 16 MiB + 16 bytes is
 * 22,369,728 characters of base64url — and it fits with its header and frame.
 */
export const MAX_FRAME = 24 * 1024 * 1024

/** The largest frame before a login, either way: 64 KiB — challenges, logins, a genesis, joins and accepts are small. */
export const PRE_LOGIN_MAX = 64 * 1024

/** Why the relay refused a request. */
export const ERROR_CODES = [
  'bad_frame', 'unsupported_version', 'too_large', 'login_failed', 'unknown_brain', 'brain_exists', 'grant_invalid',
  'refused', 'duplicate_op', 'forbidden', 'invite_closed', 'rate_limited', 'quota_exceeded', 'internal',
] as const
export type ErrorCode = typeof ERROR_CODES[number]

/** WebSocket close codes the relay uses (1009, too large, is the WebSocket layer's own). */
export const CLOSE = {
  bad_frame: 4000,
  unsupported_version: 4001,
  login_failed: 4003,
  revoked: 4004,
  rate_limited: 4008,
  too_slow: 4009,
} as const

/** Why an invite no longer takes a join. */
export const INVITE_CLOSED_REASONS = ['taken', 'cancelled', 'expired'] as const
export type InviteClosedReason = typeof INVITE_CLOSED_REASONS[number]

type Obj = Record<string, unknown>

/** What a device sends. */
export type ClientFrame =
  | { t: 'login', response: Obj }
  | { t: 'create', genesis: Obj, grant: string }
  | { t: 'join', join: Obj }
  | { t: 'subscribe', from: number }
  | { t: 'append', req: number, record: Obj }
  | { t: 'key_put', req: number, wrapped: Obj }
  | { t: 'keys', req: number }
  | { t: 'invite_put', req: number, notice: Obj }
  | { t: 'invite_cancel', req: number, invite_id: string }
  | { t: 'invite_accept', req: number, accept: Obj }

/** What the relay sends. */
export type RelayFrame =
  | { t: 'challenge', challenge: Obj }
  | { t: 'welcome', member: string, device: string, head: { seq: number, at: string } }
  | { t: 'created', seq: 1, at: string }
  | { t: 'op', seq: number, at: string, record: Obj }
  | { t: 'caught_up', seq: number }
  | { t: 'appended', req: number, seq: number, at: string }
  | { t: 'ok', req: number }
  | { t: 'keys', req: number, wrapped: Obj[] }
  | { t: 'key', wrapped: Obj }
  | { t: 'join', join: Obj }
  | { t: 'join_waiting', invite_id: string }
  | { t: 'accept', accept: Obj }
  | { t: 'invite_closed', invite_id: string, reason: InviteClosedReason }
  | { t: 'error', req: number | null, code: ErrorCode, message: string }

/** A field's reader: throws ProtocolError unless the value is well-formed. */
type Check = (value: unknown, what: string) => void

const object: Check = (v, what) => { asObject(v, what) }
const text: Check = (v, what) => { if (typeof v !== 'string') throw new ProtocolError(`${what} is a string`) }
const req: Check = (v, what) => { if (!Number.isSafeInteger(v) || (v as number) < 1) throw new ProtocolError(`${what} is a positive integer`) }
const seq = req
const at: Check = (v, what) => { if (typeof v !== 'string' || !ISO_MS.test(v)) throw new ProtocolError(`${what} is ISO-8601 UTC with milliseconds`) }
const key: Check = (v, what) => { fromBase64url(v, KEY_BYTES, what) }
const inviteId: Check = (v, what) => { fromBase64url(v, INVITE_ID_BYTES, what) }
const oneOf = (values: readonly string[]): Check => (v, what) => { if (!values.includes(v as string)) throw new ProtocolError(`${what} is not one of ${values.join(', ')}`) }
const one: Check = (v, what) => { if (v !== 1) throw new ProtocolError(`${what} is 1`) }
const objects: Check = (v, what) => {
  if (!Array.isArray(v)) throw new ProtocolError(`${what} is a list`)
  v.forEach((w, i) => object(w, `${what}[${i}]`))
}
const head: Check = (v, what) => {
  const h = asObject(v, what)
  exactFields(h, ['seq', 'at'], what)
  seq(h.seq, `${what}.seq`)
  at(h.at, `${what}.at`)
}
const reqOrNull: Check = (v, what) => { if (v !== null) req(v, what) }

/** Each frame's fields with their readers, and whether it may travel before a login. */
interface Shape { fields: Record<string, Check>, preLogin: boolean }

const CLIENT: Record<ClientFrame['t'], Shape> = {
  login: { fields: { response: object }, preLogin: true },
  create: { fields: { genesis: object, grant: text }, preLogin: true },
  join: { fields: { join: object }, preLogin: true },
  subscribe: { fields: { from: seq }, preLogin: false },
  append: { fields: { req, record: object }, preLogin: false },
  key_put: { fields: { req, wrapped: object }, preLogin: false },
  keys: { fields: { req }, preLogin: false },
  invite_put: { fields: { req, notice: object }, preLogin: false },
  invite_cancel: { fields: { req, invite_id: inviteId }, preLogin: false },
  invite_accept: { fields: { req, accept: object }, preLogin: false },
}

const RELAY: Record<RelayFrame['t'], Shape> = {
  challenge: { fields: { challenge: object }, preLogin: true },
  welcome: { fields: { member: key, device: key, head }, preLogin: true },
  created: { fields: { seq: one, at }, preLogin: true },
  op: { fields: { seq, at, record: object }, preLogin: false },
  caught_up: { fields: { seq }, preLogin: false },
  appended: { fields: { req, seq, at }, preLogin: false },
  ok: { fields: { req }, preLogin: false },
  keys: { fields: { req, wrapped: objects }, preLogin: false },
  key: { fields: { wrapped: object }, preLogin: false },
  join: { fields: { join: object }, preLogin: false },
  join_waiting: { fields: { invite_id: inviteId }, preLogin: true },
  accept: { fields: { accept: object }, preLogin: true },
  invite_closed: { fields: { invite_id: inviteId, reason: oneOf(INVITE_CLOSED_REASONS) }, preLogin: true },
  error: { fields: { req: reqOrNull, code: oneOf(ERROR_CODES), message: text }, preLogin: true },
}

/** A frame's byte limit: PRE_LOGIN_MAX until the device is logged in, then MAX_FRAME. */
export function frameLimit(loggedIn: boolean): number {
  return loggedIn ? MAX_FRAME : PRE_LOGIN_MAX
}

/** A frame as the WebSocket delivered it, as text: its byte length checked first, then UTF-8. */
function frameText(data: string | Uint8Array, limit: number): string {
  const bytes = typeof data === 'string' ? (data.length > limit ? limit + 1 : Buffer.byteLength(data, 'utf8')) : data.length
  if (bytes > limit) throw new ProtocolError(`a frame is larger than ${limit} bytes`)
  return typeof data === 'string' ? data : utf8(data, 'a frame')
}

function parseFrame(shapes: Record<string, Shape>, data: string | Uint8Array, loggedIn: boolean, side: string): Obj {
  const raw = frameText(data, frameLimit(loggedIn))
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new ProtocolError(`a ${side} frame is not JSON`)
  }
  const f = asObject(value, `a ${side} frame`)
  const t = f.t
  if (typeof t !== 'string' || !Object.hasOwn(shapes, t)) throw new ProtocolError(`a ${side} frame has no type ${String(t)}`)
  const shape = shapes[t]
  if (!loggedIn && !shape.preLogin) throw new ProtocolError(`a ${t} frame comes after the login`)
  exactFields(f, ['t', ...Object.keys(shape.fields)], `a ${t} frame`)
  for (const [name, check] of Object.entries(shape.fields)) check(f[name], `${t}.${name}`)
  return f
}

/** Reads a frame a device sent: throws ProtocolError unless it is one, within its size, allowed at this point. */
export function parseClientFrame(data: string | Uint8Array, loggedIn: boolean): ClientFrame {
  return parseFrame(CLIENT, data, loggedIn, 'client') as ClientFrame
}

/** Reads a frame the relay sent: throws ProtocolError unless it is one, within its size, allowed at this point. */
export function parseRelayFrame(data: string | Uint8Array, loggedIn: boolean): RelayFrame {
  return parseFrame(RELAY, data, loggedIn, 'relay') as RelayFrame
}

/** A frame as the text to send: refused when it is larger than the other side would read. */
export function encodeFrame(frame: ClientFrame | RelayFrame, loggedIn: boolean): string {
  const raw = JSON.stringify(frame)
  frameText(raw, frameLimit(loggedIn))
  return raw
}

/** The path a device connects to for `brain`. */
export function syncPath(brain: string): string {
  if (!UUID.test(brain)) throw new ProtocolError('the brain is not a lowercase UUID')
  return `/sync/${PROTOCOL_VERSION}/${brain}`
}

/** The brain a connection's path names; UnsupportedVersionError for another protocol version. */
export function parseSyncPath(path: string): string {
  const parts = path.split('/')
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'sync') throw new ProtocolError('not a sync path')
  if (parts[2] !== String(PROTOCOL_VERSION)) throw new UnsupportedVersionError(parts[2])
  if (!UUID.test(parts[3])) throw new ProtocolError('the brain is not a lowercase UUID')
  return parts[3]
}
