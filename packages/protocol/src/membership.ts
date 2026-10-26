import { canonicalJson } from './canonical'
import { verifyDeviceCert, type DeviceCert } from './keys'
import type { BrainKey, OpenedOp } from './seal'
import { KEY_BYTES, NONCE_BYTES, ProtocolError, TAG_BYTES, asObject, exactFields, fromBase64url, openBox, sealBox, sodium, utf8 } from './wire'

// --- Membership (v0.21) ----------------------------------------------------------
//
// Who may write to a shared brain follows from its log: the genesis names the
// first owner, the team.* records add and remove members and devices and
// rotate the brain key. They travel in the clear (seal.ts), so the relay and
// every member run this same reducer over them and arrive at the same member
// set at every position. Names stay out of the relay's sight: a member's
// handle — what their ops' provenance says — rides in its record encrypted
// under the brain key of that epoch, and only members can read it
// (spec team-brain-protocol-package-spec §3).

export type Role = 'owner' | 'member'

/** Bytes sealed with XChaCha20-Poly1305 under a brain key: a member's handle, or a rotation's previous key. */
export interface Box {
  nonce: string
  ct: string
}

export interface Member {
  role: Role
  /** The member's handle as their joining record carried it, with the epoch and record it was sealed in. */
  handle: { epoch: number, op_id: string, box: Box }
  /** The member's devices, by device signing key. */
  devices: Record<string, DeviceCert>
}

/** A shared brain's members at one position of its log. Members are kept in the order they joined. */
export interface MemberSet {
  brain: string
  epoch: number
  /** The brain key chain, by epoch (keys.length = epoch + 1): each key's id and, from epoch 1, the previous key sealed under it. */
  keys: Array<{ key_id: string, prev: Box | null }>
  /** Set by a removal or a revocation: until the next rotation, the brain takes no sealed op and no new member or device. */
  rotation_due: boolean
  members: Record<string, Member>
}

/** A handle is sealed padded to this many bytes — a length byte, the UTF-8 text, zeros — so its ciphertext says nothing about it. */
export const HANDLE_BYTES = 64
const ROLES: readonly string[] = ['owner', 'member']

/** Seals `handle` for a membership record of `brain`: the record's op_id and the member it names are bound to it. */
export function sealHandle(handle: string, at: { brain: string, op_id: string, member: string }, key: BrainKey): Box {
  return sealHandleWith(sodium.randombytes_buf(NONCE_BYTES), handle, at, key)
}

/** sealHandle with a given nonce — for the test vectors. */
export function sealHandleWith(nonce: Uint8Array, handle: string, at: { brain: string, op_id: string, member: string }, key: BrainKey): Box {
  return sealBox(padHandle(handle), canonicalJson(at), nonce, key.key)
}

/**
 * The member set the genesis founds: `brain.genesis {state_hash, root}` with
 * root = {member, device_cert, handle, key_id}, signed by the root's device.
 * The first owner, epoch 0.
 */
export function genesisMembers(genesis: OpenedOp): MemberSet {
  const { envelope } = genesis
  if (envelope.call !== 'brain.genesis') throw new ProtocolError(`the first record is ${envelope.call}, not brain.genesis`)
  const args = asObject(envelope.args, 'the genesis args')
  exactFields(args, ['state_hash', 'root'], 'the genesis args')
  const root = asObject(args.root, 'root')
  exactFields(root, ['member', 'device_cert', 'handle', 'key_id'], 'root')
  const brain = envelope.team.brain
  const cert = memberCert(root.device_cert, brain, root.member)
  if (envelope.team.device !== cert.device_sign) throw new ProtocolError('the genesis is not signed by the root\'s device')
  fromBase64url(root.key_id, KEY_BYTES, 'root.key_id')
  return {
    brain, epoch: 0, keys: [{ key_id: root.key_id as string, prev: null }], rotation_due: false,
    members: { [cert.member]: { role: 'owner', handle: { epoch: 0, op_id: envelope.op_id, box: box(root.handle, 'handle', HANDLE_BYTES) }, devices: { [cert.device_sign]: cert } } },
  }
}

/**
 * The member set after a team.* record — or ProtocolError when the record
 * is not allowed there; every reader refuses it the same way. The signing
 * device must be a current device of some member. Rules:
 * - add_member {member, role, device_cert, handle}: by an owner, for someone not yet a member.
 * - add_device {device_cert}: by a device of the same member.
 * - revoke_device {device}: by a device of that member or of an owner.
 * - remove_member {member}: by an owner; never the last owner.
 * - rotate_key {epoch, key_id, prev}: by an owner, to the next epoch.
 * A removal or revocation makes a rotation due; until it comes, nobody is added.
 */
export function applyMembership(set: MemberSet, opened: OpenedOp): MemberSet {
  const { envelope } = opened
  const signer = memberOfDevice(set, envelope.team.device)
  if (!signer) throw new ProtocolError('the record\'s device is not a current device of a member')
  const isOwner = set.members[signer].role === 'owner'
  const args = asObject(envelope.args, `${envelope.call} args`)
  const next: MemberSet = { ...set, members: { ...set.members } }

  switch (envelope.call) {
    case 'team.add_member': {
      exactFields(args, ['member', 'role', 'device_cert', 'handle'], 'team.add_member args')
      if (!isOwner) throw new ProtocolError('only an owner adds a member')
      if (set.rotation_due) throw new ProtocolError('a key rotation is due; nobody is added before it')
      if (typeof args.member === 'string' && Object.hasOwn(set.members, args.member)) throw new ProtocolError('the member is a member already')
      if (typeof args.role !== 'string' || !ROLES.includes(args.role)) throw new ProtocolError('role is owner or member')
      const cert = newDeviceCert(set, args.device_cert, args.member)
      next.members[cert.member] = { role: args.role as Role, handle: { epoch: set.epoch, op_id: envelope.op_id, box: box(args.handle, 'handle', HANDLE_BYTES) }, devices: { [cert.device_sign]: cert } }
      return next
    }
    case 'team.add_device': {
      exactFields(args, ['device_cert'], 'team.add_device args')
      if (set.rotation_due) throw new ProtocolError('a key rotation is due; nothing is added before it')
      const cert = newDeviceCert(set, args.device_cert, signer)
      next.members[signer] = { ...set.members[signer], devices: { ...set.members[signer].devices, [cert.device_sign]: cert } }
      return next
    }
    case 'team.revoke_device': {
      exactFields(args, ['device'], 'team.revoke_device args')
      const owner = memberOfDevice(set, args.device)
      if (!owner) throw new ProtocolError('the device is not a current device of a member')
      if (owner !== signer && !isOwner) throw new ProtocolError('a device is revoked by its member or an owner')
      const { [args.device as string]: _revoked, ...devices } = set.members[owner].devices
      next.members[owner] = { ...set.members[owner], devices }
      next.rotation_due = true
      return next
    }
    case 'team.remove_member': {
      exactFields(args, ['member'], 'team.remove_member args')
      if (!isOwner) throw new ProtocolError('only an owner removes a member')
      const target = typeof args.member === 'string' && Object.hasOwn(set.members, args.member) ? set.members[args.member] : undefined
      if (!target) throw new ProtocolError('the member is not a member')
      if (target.role === 'owner' && Object.values(set.members).filter(m => m.role === 'owner').length === 1) {
        throw new ProtocolError('the last owner is not removed')
      }
      delete next.members[args.member as string]
      next.rotation_due = true
      return next
    }
    case 'team.rotate_key': {
      exactFields(args, ['epoch', 'key_id', 'prev'], 'team.rotate_key args')
      if (!isOwner) throw new ProtocolError('only an owner rotates the brain key')
      if (args.epoch !== set.epoch + 1) throw new ProtocolError(`the next epoch is ${set.epoch + 1}`)
      fromBase64url(args.key_id, KEY_BYTES, 'key_id')
      const prev = box(args.prev, 'prev', KEY_BYTES)
      return { ...next, epoch: set.epoch + 1, keys: [...set.keys, { key_id: args.key_id as string, prev }], rotation_due: false }
    }
    default:
      throw new ProtocolError(`${envelope.call} is not a membership record`)
  }
}

/** The member whose current device `device` is. */
export function memberOfDevice(set: MemberSet, device: unknown): string | undefined {
  if (typeof device !== 'string') return undefined
  return Object.keys(set.members).find(m => Object.hasOwn(set.members[m].devices, device))
}

/**
 * Every member's handle, read with the brain keys. A handle belongs to the
 * member who joined with it first; a later member with the same handle gets
 * none, so no op of theirs passes checkAuthor. A box that does not open, or
 * a handle that is not one, counts as none as well.
 */
export function memberHandles(set: MemberSet, keyFor: (epoch: number) => Uint8Array | undefined): Record<string, string | null> {
  const taken = new Set<string>()
  const handles: Record<string, string | null> = {}
  for (const [member, { handle }] of Object.entries(set.members)) {
    const key = keyFor(handle.epoch)
    let text: string | null = null
    if (key) {
      try {
        text = unpadHandle(openBox(handle.box.ct, handle.box.nonce, canonicalJson({ brain: set.brain, op_id: handle.op_id, member }), key, 'the handle does not open'))
      } catch {
        text = null
      }
    }
    handles[member] = text !== null && !taken.has(text) ? text : null
    if (text !== null) taken.add(text)
  }
  return handles
}

/**
 * Throws ProtocolError unless `opened` may be applied at `set` (a member's
 * view; the relay sees no handles): its device is a current device, its
 * provenance names that member's handle, and a sealed op is sealed under the
 * current epoch with no rotation due. A membership record is then checked by
 * applyMembership as well.
 */
export function checkAuthor(set: MemberSet, opened: OpenedOp, handles: Record<string, string | null>): void {
  const member = memberOfDevice(set, opened.envelope.team.device)
  if (!member) throw new ProtocolError('the op\'s device is not a current device of a member')
  if (handles[member] === null || handles[member] !== opened.envelope.provenance.handle) throw new ProtocolError('the op\'s provenance is not its member\'s handle')
  if (opened.epoch !== null) {
    if (opened.epoch !== set.epoch) throw new ProtocolError(`the op is sealed under epoch ${opened.epoch}, the brain is at ${set.epoch}`)
    if (set.rotation_due) throw new ProtocolError('a key rotation is due; the brain takes no sealed op before it')
  }
}

function memberCert(value: unknown, brain: string, member: unknown): DeviceCert {
  const cert = verifyDeviceCert(value)
  if (cert.brain !== brain) throw new ProtocolError('the device certificate is for another brain')
  if (cert.member !== member) throw new ProtocolError('the device certificate is for another member')
  return cert
}

function newDeviceCert(set: MemberSet, value: unknown, member: unknown): DeviceCert {
  const cert = memberCert(value, set.brain, member)
  if (memberOfDevice(set, cert.device_sign)) throw new ProtocolError('the device is a device already')
  return cert
}

/** `handle` as the 64 bytes that are sealed: its UTF-8 length, the UTF-8 text, zeros. */
export function padHandle(handle: string): Uint8Array {
  checkHandle(handle)
  const text = sodium.from_string(handle)
  const padded = new Uint8Array(HANDLE_BYTES)
  padded[0] = text.length
  padded.set(text, 1)
  return padded
}

/** The handle in `padded`, which must be exactly padHandle's form; throws ProtocolError otherwise. */
export function unpadHandle(padded: Uint8Array): string {
  const length = padded[0]
  if (padded.length !== HANDLE_BYTES || length >= HANDLE_BYTES || padded.subarray(1 + length).some(b => b !== 0)) throw new ProtocolError('not a padded handle')
  const text = utf8(padded.subarray(1, 1 + length), 'the handle')
  checkHandle(text)
  return text
}

/** `value` as a box sealing exactly `plainBytes` bytes. */
export function box(value: unknown, what: string, plainBytes: number): Box {
  const b = asObject(value, what)
  exactFields(b, ['nonce', 'ct'], what)
  fromBase64url(b.nonce, NONCE_BYTES, `${what}.nonce`)
  fromBase64url(b.ct, plainBytes + TAG_BYTES, `${what}.ct`)
  return { nonce: b.nonce as string, ct: b.ct as string }
}

function checkHandle(handle: string): void {
  const bytes = sodium.from_string(handle).length
  if (bytes < 1 || bytes >= HANDLE_BYTES || handle.trim() !== handle || /\p{C}/u.test(handle)) {
    throw new ProtocolError(`a handle is 1–${HANDLE_BYTES - 1} bytes of UTF-8, without surrounding space or control characters`)
  }
}
