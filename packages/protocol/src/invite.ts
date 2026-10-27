import { canonicalJson } from './canonical'
import { signText, verifyDeviceCert, verifyText, type DeviceCert, type KeyPair } from './keys'
import { HANDLE_BYTES, box, memberOfDevice, padHandle, unpadHandle, type Box, type MemberSet } from './membership'
import { sha256Hex } from './op'
import {
  HASH, ISO_MS, KEY_BYTES, NONCE_BYTES, PROTOCOL_VERSION, ProtocolError, UUID, UnsupportedVersionError,
  asObject, checkVersion, exactFields, fromBase64url, openBox, sealBox, sodium, toBase64url,
} from './wire'

// --- Invites (v0.21) -------------------------------------------------------------
//
// An owner's cockpit draws a one-time secret and puts it into an invite link,
// which travels to the invitee out of band; the secret sits in the link's
// fragment, so it never reaches a server. Everything the two cockpits then
// exchange through the relay is bound to that secret: the join (the invitee's
// identity, device certificate and handle — the handle sealed, so the relay
// never sees it) and the accept (the inviter's device certificate) each carry
// a MAC the relay cannot make, so it cannot swap a key in either direction.
// The relay holds the invite as a notice signed by the owner, and it and the
// inviter's cockpit each take a join only once and only before it expires
// (decision team-brain-device-keys-invite-link; spec §5).

/** An invite as the inviter's cockpit keeps it. `redeemed` is set once a join was taken. */
export interface Invite {
  relay: string
  brain: string
  invite_id: string
  secret: Uint8Array
  expires_at: string
  redeemed: boolean
}

/** What the relay keeps of an invite: no secret, signed by the owner device that made it. */
export interface InviteNotice {
  v: 1
  brain: string
  invite_id: string
  expires_at: string
  inviter: string
  sig: string
}

/** The invitee's join: who they are, their device, their handle (sealed under the invite secret), and the MAC. */
export interface JoinRequest {
  v: 1
  brain: string
  invite_id: string
  member: string
  device_cert: DeviceCert
  handle: Box
  mac: string
}

/**
 * Where the log the invitee will replay stands, as the inviter saw it when it
 * answered: the genesis op_id, and the inviter's last entry with its chain
 * link. A relay that serves another log, or another history, misses it.
 */
export interface LogAnchor {
  genesis: string
  seq: number
  head_hash: string
}

/** The inviter's answer: its device's certificate and the log anchor, bound to the exact join. */
export interface JoinAccept {
  v: 1
  brain: string
  invite_id: string
  join_hash: string
  inviter: DeviceCert
  anchor: LogAnchor
  mac: string
}

/** An invite is good for this many days. */
export const INVITE_DAYS = 7

const SECRET_BYTES = KEY_BYTES
const INVITE_ID_BYTES = 16
const MAC_BYTES = 32
const NOTICE_DOMAIN = 'eml-invite-notice-v1\n'

/** A new invite of `brain` on the relay at `relay` (a host name, with a port if any), made at `now`. */
export function newInvite(relay: string, brain: string, now: string): Invite {
  if (!ISO_MS.test(now)) throw new ProtocolError('now is ISO-8601 UTC with milliseconds')
  if (!UUID.test(brain)) throw new ProtocolError('the brain is not a lowercase UUID')
  const invite: Invite = {
    relay, brain,
    invite_id: toBase64url(sodium.randombytes_buf(INVITE_ID_BYTES)),
    secret: sodium.randombytes_buf(SECRET_BYTES),
    expires_at: new Date(Date.parse(now) + INVITE_DAYS * 86400_000).toISOString(),
    redeemed: false,
  }
  if (parseInviteLink(inviteLink(invite)).relay !== relay) throw new ProtocolError(`the relay is not a host name: ${relay}`)
  return invite
}

/** The link the invitee pastes into their cockpit: https://<relay>/i/1/<brain>/<invite_id>#<secret>. */
export function inviteLink(invite: Invite): string {
  return `https://${invite.relay}/i/${PROTOCOL_VERSION}/${invite.brain}/${invite.invite_id}#${toBase64url(invite.secret)}`
}

/** The parts of an invite link, when it is exactly one; a link of a newer version is an UnsupportedVersionError. */
export function parseInviteLink(link: string): { relay: string, brain: string, invite_id: string, secret: Uint8Array } {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    throw new ProtocolError('the invite link is not a URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || !url.host) throw new ProtocolError('the invite link is not https://<relay>/i/…#<secret>')
  const parts = url.pathname.split('/')
  if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'i') throw new ProtocolError('the invite link\'s path is not /i/<version>/<brain>/<invite>')
  if (parts[2] !== String(PROTOCOL_VERSION)) throw new UnsupportedVersionError(parts[2])
  if (!UUID.test(parts[3])) throw new ProtocolError('the invite link\'s brain is not a lowercase UUID')
  fromBase64url(parts[4], INVITE_ID_BYTES, 'the invite id')
  const secret = fromBase64url(url.hash.slice(1), SECRET_BYTES, 'the invite secret')
  return { relay: url.host, brain: parts[3], invite_id: parts[4], secret }
}

/** The notice the relay keeps: the invite without its secret, signed by `owner` (a device of an owner). */
export function inviteNotice(invite: Invite, owner: KeyPair): InviteNotice {
  const body = { v: PROTOCOL_VERSION, brain: invite.brain, invite_id: invite.invite_id, expires_at: invite.expires_at, inviter: owner.publicKey }
  return { ...body, sig: signText(owner, NOTICE_DOMAIN, canonicalJson(body)) }
}

/** The relay's check of a notice at `now`: exactly one, for this brain, expiring within INVITE_DAYS, signed by a current device of an owner. */
export function verifyInviteNotice(set: MemberSet, value: unknown, now: string): InviteNotice {
  if (!ISO_MS.test(now)) throw new ProtocolError('now is ISO-8601 UTC with milliseconds')
  const n = asObject(value, 'an invite notice')
  checkVersion(n.v)
  exactFields(n, ['v', 'brain', 'invite_id', 'expires_at', 'inviter', 'sig'], 'an invite notice')
  if (n.brain !== set.brain) throw new ProtocolError('the invite is for another brain')
  fromBase64url(n.invite_id, INVITE_ID_BYTES, 'the invite id')
  if (typeof n.expires_at !== 'string' || !ISO_MS.test(n.expires_at)) throw new ProtocolError('expires_at is not ISO-8601 UTC with milliseconds')
  if (Date.parse(n.expires_at) > Date.parse(now) + INVITE_DAYS * 86400_000) throw new ProtocolError(`an invite is open for at most ${INVITE_DAYS} days`)
  const member = memberOfDevice(set, n.inviter)
  if (!member || set.members[member].role !== 'owner') throw new ProtocolError('the invite is not from a current device of an owner')
  const { sig, ...body } = n
  if (!verifyText(n.inviter as string, NOTICE_DOMAIN, canonicalJson(body), sig as string)) throw new ProtocolError('the invite notice is not signed by its inviter')
  return n as unknown as InviteNotice
}

/** Throws unless an invite with this expiry, redeemed or not, still takes a join at `now` — the relay and the inviter both ask. */
export function checkInviteOpen(invite: { expires_at: string, redeemed: boolean }, now: string): void {
  if (!ISO_MS.test(now)) throw new ProtocolError('now is ISO-8601 UTC with milliseconds')
  if (invite.redeemed) throw new ProtocolError('the invite was used already')
  if (now >= invite.expires_at) throw new ProtocolError(`the invite expired at ${invite.expires_at}`)
}

/**
 * The invitee's join for the invite in `link`: their identity, their device's
 * certificate and their handle, sealed and MAC'd under the invite secret.
 */
export function joinRequest(link: string, member: KeyPair, deviceCert: DeviceCert, handle: string): JoinRequest {
  return joinRequestWith(sodium.randombytes_buf(NONCE_BYTES), link, member, deviceCert, handle)
}

/** joinRequest with a given nonce — for the test vectors. */
export function joinRequestWith(nonce: Uint8Array, link: string, member: KeyPair, deviceCert: DeviceCert, handle: string): JoinRequest {
  const { brain, invite_id, secret } = parseInviteLink(link)
  if (deviceCert.member !== member.publicKey || deviceCert.brain !== brain) throw new ProtocolError('the device certificate is not the joiner\'s for this brain')
  const body = { v: PROTOCOL_VERSION, brain, invite_id, member: member.publicKey, device_cert: deviceCert, handle: sealBox(padHandle(handle), handleAad(brain, invite_id, member.publicKey), nonce, encKey(secret)) }
  return { ...body, mac: mac(secret, 'eml-invite-join-v1', body) }
}

/**
 * The inviter's reading of a join at `now`: exactly a join of this invite,
 * the invite still open, the MAC under its secret, the certificate the
 * joiner's for this brain, and the handle opened. The caller marks the
 * invite redeemed once the owner confirmed the join.
 */
export function openJoin(invite: Invite, value: unknown, now: string): { member: string, device_cert: DeviceCert, handle: string, join_hash: string } {
  checkInviteOpen(invite, now)
  const j = asObject(value, 'a join')
  checkVersion(j.v)
  exactFields(j, ['v', 'brain', 'invite_id', 'member', 'device_cert', 'handle', 'mac'], 'a join')
  if (j.brain !== invite.brain || j.invite_id !== invite.invite_id) throw new ProtocolError('the join is for another invite')
  const { mac: given, ...body } = j
  checkMac(invite.secret, 'eml-invite-join-v1', body, given)
  const cert = verifyDeviceCert(j.device_cert)
  if (cert.member !== j.member || cert.brain !== invite.brain) throw new ProtocolError('the device certificate is not the joiner\'s for this brain')
  const sealed = box(j.handle, 'handle', HANDLE_BYTES)
  const padded = openBox(sealed.ct, sealed.nonce, handleAad(invite.brain, invite.invite_id, cert.member), encKey(invite.secret), 'the join\'s handle does not open under the invite secret')
  return { member: cert.member, device_cert: cert, handle: unpadHandle(padded), join_hash: sha256Hex(canonicalJson(j)) }
}

/**
 * The inviter's answer to a join it opened: its device's certificate and the
 * anchor of its log (genesis op_id, its last seq and that entry's chain link),
 * bound to that join by its hash and MAC'd.
 */
export function joinAccept(invite: Invite, joinHash: string, inviterCert: DeviceCert, anchor: LogAnchor): JoinAccept {
  if (inviterCert.brain !== invite.brain) throw new ProtocolError('the inviter\'s certificate is for another brain')
  checkAnchorFields(anchor)
  const body = { v: PROTOCOL_VERSION, brain: invite.brain, invite_id: invite.invite_id, join_hash: joinHash, inviter: inviterCert, anchor: { genesis: anchor.genesis, seq: anchor.seq, head_hash: anchor.head_hash } }
  return { ...body, mac: mac(invite.secret, 'eml-invite-accept-v1', body) }
}

/**
 * The invitee's reading of the answer to its `join`: exactly an accept of
 * this invite, for this join, with the MAC under the secret of `link`.
 * Returns the inviter's certificate — the invitee takes a wrapped brain key
 * only from that device (unwrapInviteKey) — and the log anchor, which the
 * log the relay serves must meet (checkAnchor).
 */
export function openAccept(link: string, join: JoinRequest, value: unknown): { inviter: DeviceCert, anchor: LogAnchor } {
  const { brain, invite_id, secret } = parseInviteLink(link)
  const a = asObject(value, 'an accept')
  checkVersion(a.v)
  exactFields(a, ['v', 'brain', 'invite_id', 'join_hash', 'inviter', 'anchor', 'mac'], 'an accept')
  if (a.brain !== brain || a.invite_id !== invite_id) throw new ProtocolError('the accept is for another invite')
  const { mac: given, ...body } = a
  checkMac(secret, 'eml-invite-accept-v1', body, given)
  if (a.join_hash !== sha256Hex(canonicalJson(join))) throw new ProtocolError('the accept answers another join')
  const cert = verifyDeviceCert(a.inviter)
  if (cert.brain !== brain) throw new ProtocolError('the inviter\'s certificate is for another brain')
  const anchor = asObject(a.anchor, 'the anchor')
  exactFields(anchor, ['genesis', 'seq', 'head_hash'], 'the anchor')
  checkAnchorFields(anchor)
  return { inviter: cert, anchor: anchor as unknown as LogAnchor }
}

/**
 * Throws ProtocolError unless the log the invitee replayed meets the accept's
 * anchor: its genesis op_id is the anchor's, and its chain link at the
 * anchor's seq is the anchor's head_hash. A relay that fabricated a brain, or
 * shows the invitee another history, fails here.
 */
export function checkAnchor(anchor: LogAnchor, genesis: string, hashAt: (seq: number) => string | undefined): void {
  if (genesis !== anchor.genesis) throw new ProtocolError('the log served is not the brain the inviter answered from: another genesis')
  const hash = hashAt(anchor.seq)
  if (hash === undefined) throw new ProtocolError(`the log served does not reach seq ${anchor.seq}, where the inviter stood`)
  if (hash !== anchor.head_hash) throw new ProtocolError(`the log served differs from the inviter's at seq ${anchor.seq}`)
}

function checkAnchorFields(anchor: Record<string, unknown> | LogAnchor): void {
  if (typeof anchor.genesis !== 'string' || !UUID.test(anchor.genesis)) throw new ProtocolError('anchor.genesis is not a lowercase UUID')
  if (!Number.isSafeInteger(anchor.seq) || (anchor.seq as number) < 1) throw new ProtocolError('anchor.seq is a positive integer')
  if (typeof anchor.head_hash !== 'string' || !HASH.test(anchor.head_hash)) throw new ProtocolError('anchor.head_hash is not 64 lowercase hex digits')
}

// The secret keys two things, so it is split into two keys (BLAKE2b keyed with the secret, one label each).
function macKey(secret: Uint8Array): Uint8Array {
  return sodium.crypto_generichash(KEY_BYTES, sodium.from_string('eml-invite-mac-v1'), secret)
}

function encKey(secret: Uint8Array): Uint8Array {
  return sodium.crypto_generichash(KEY_BYTES, sodium.from_string('eml-invite-enc-v1'), secret)
}

function handleAad(brain: string, invite_id: string, member: string): string {
  return canonicalJson({ brain, invite_id, member })
}

/** HMAC-SHA-512-256 (crypto_auth) under the invite's MAC key over the type tag and the canonical body. */
function mac(secret: Uint8Array, t: string, body: object): string {
  return toBase64url(sodium.crypto_auth(sodium.from_string(canonicalJson({ t, ...body })), macKey(secret)))
}

function checkMac(secret: Uint8Array, t: string, body: object, given: unknown): void {
  const tag = fromBase64url(given, MAC_BYTES, 'the MAC')
  if (!sodium.crypto_auth_verify(tag, sodium.from_string(canonicalJson({ t, ...body })), macKey(secret))) throw new ProtocolError('the MAC is not the invite\'s')
}
