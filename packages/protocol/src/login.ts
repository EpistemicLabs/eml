import { canonicalJson } from './canonical'
import { signText, verifyText, type KeyPair } from './keys'
import { memberOfDevice, type MemberSet } from './membership'
import { UnsupportedVersionError } from './seal'
import { ProtocolError, asObject, exactFields, fromBase64url, sodium, toBase64url } from './sodium'

// --- Relay login (v0.21) ---------------------------------------------------------
//
// A device logs in to the relay for one brain by signing the relay's
// challenge — no password, no bearer token (spec team-brain-protocol-package-spec
// §7). The challenge names the relay's host and the brain, so a response is
// good for exactly that relay, that brain and that nonce; the device checks
// that the host is the one it dialled, so a relay cannot pass another relay's
// challenge through. The relay takes a response once, within a minute, and
// only from a current device of a member.

/** What the relay sends: a fresh nonce for one host and brain, and when it issued it. */
export interface LoginChallenge {
  v: 1
  relay: string
  brain: string
  nonce: string
  issued_at: string
}

/** What the device answers: the challenge's relay, brain and nonce, its key, its signature. */
export interface LoginResponse {
  v: 1
  relay: string
  brain: string
  nonce: string
  device: string
  sig: string
}

/** A challenge is answered within this many milliseconds. */
export const LOGIN_WINDOW_MS = 60_000

const NONCE_BYTES = 32
const KEY_BYTES = 32
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const LOGIN_DOMAIN = 'eml-relay-login-v1\n'

/** The relay's challenge for a device logging in to `brain` at `now`. */
export function loginChallenge(relay: string, brain: string, now: string): LoginChallenge {
  if (!relay) throw new ProtocolError('the relay host is empty')
  if (!UUID.test(brain)) throw new ProtocolError('the brain is not a lowercase UUID')
  if (!ISO_MS.test(now)) throw new ProtocolError('now is ISO-8601 UTC with milliseconds')
  return { v: 1, relay, brain, nonce: toBase64url(sodium.randombytes_buf(NONCE_BYTES)), issued_at: now }
}

/**
 * The device's answer to `value`, a challenge it received from the relay at
 * `host` for `brain`: refused unless the challenge names exactly that host
 * and brain.
 */
export function loginResponse(value: unknown, host: string, brain: string, device: KeyPair): LoginResponse {
  const c = asObject(value, 'a login challenge')
  if (c.v !== 1) throw new UnsupportedVersionError(c.v)
  exactFields(c, ['v', 'relay', 'brain', 'nonce', 'issued_at'], 'a login challenge')
  if (c.relay !== host) throw new ProtocolError(`the challenge is for the relay ${String(c.relay)}, not ${host}`)
  if (c.brain !== brain) throw new ProtocolError('the challenge is for another brain')
  fromBase64url(c.nonce, NONCE_BYTES, 'the nonce')
  const body = { relay: host, brain, nonce: c.nonce as string, device: device.publicKey }
  return { v: 1, ...body, sig: signText(device, LOGIN_DOMAIN, canonicalJson(body)) }
}

/**
 * The relay's check of `value` against the challenge it issued: exactly a
 * response to it (relay, brain, nonce), the challenge unused and younger
 * than a minute at `now`, the device a current device of a member in `set`,
 * the signature the device's. Returns the member and device logged in. The
 * relay marks the challenge used, so a response is taken once.
 */
export function verifyLogin(set: MemberSet, challenge: LoginChallenge & { used: boolean }, value: unknown, now: string): { member: string, device: string } {
  if (!ISO_MS.test(now)) throw new ProtocolError('now is ISO-8601 UTC with milliseconds')
  if (challenge.used) throw new ProtocolError('the challenge was answered already')
  const age = Date.parse(now) - Date.parse(challenge.issued_at)
  if (!(age >= 0 && age < LOGIN_WINDOW_MS)) throw new ProtocolError('the challenge is older than a minute')
  const r = asObject(value, 'a login response')
  if (r.v !== 1) throw new UnsupportedVersionError(r.v)
  exactFields(r, ['v', 'relay', 'brain', 'nonce', 'device', 'sig'], 'a login response')
  if (r.relay !== challenge.relay || r.brain !== challenge.brain || r.nonce !== challenge.nonce) throw new ProtocolError('the response answers another challenge')
  if (set.brain !== challenge.brain) throw new ProtocolError('the member set is for another brain')
  fromBase64url(r.device, KEY_BYTES, 'the device key')
  const member = memberOfDevice(set, r.device)
  if (!member) throw new ProtocolError('the device is not a current device of a member')
  const { v: _v, sig, ...body } = r
  if (!verifyText(r.device as string, LOGIN_DOMAIN, canonicalJson(body), sig as string)) throw new ProtocolError('the response is not signed by its device')
  return { member, device: r.device as string }
}
