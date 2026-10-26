import { canonicalJson } from './canonical'
import { signText, verifyText, type DeviceKeys, type KeyPair } from './keys'
import { memberOfDevice, type Box, type MemberSet } from './membership'
import { UnsupportedVersionError, type BrainKey } from './seal'
import { ProtocolError, asObject, exactFields, fromBase64url, sodium, toBase64url } from './sodium'

// --- The brain key (v0.21) -------------------------------------------------------
//
// One symmetric key per epoch seals a shared brain's ops. The log names each
// key by its id (genesis root, team.rotate_key), and each rotation carries the
// previous key sealed under the new one, so the newest key opens every older
// epoch and a new member reads the whole history. A device receives a key
// wrapped for its encryption key and signed by the device that wrapped it — an
// unsigned box could be swapped by the relay for a key it knows
// (spec team-brain-protocol-package-spec §4).

/** A brain key wrapped for one device, as the relay keeps it. */
export interface WrappedKey {
  v: 1
  brain: string
  epoch: number
  recipient: string
  sealed: string
  wrapper: string
  sig: string
}

const KEY_BYTES = 32
const NONCE_BYTES = 24
const SEAL_BYTES = KEY_BYTES + 48  // crypto_box_seal: ephemeral public key (32) + MAC (16)
const KEY_ID_DOMAIN = 'eml-brain-key-id-v1'
const WRAP_DOMAIN = 'eml-wrapped-key-v1\n'

/** A new random brain key for `epoch`. */
export function newBrainKey(epoch: number): BrainKey {
  return { epoch, key: sodium.randombytes_buf(KEY_BYTES) }
}

/** The id the log names a key by: BLAKE2b-256 keyed with the key over "eml-brain-key-id-v1". */
export function keyId(key: Uint8Array): string {
  if (key.length !== KEY_BYTES) throw new ProtocolError(`a brain key is ${KEY_BYTES} bytes`)
  return toBase64url(sodium.crypto_generichash(KEY_BYTES, sodium.from_string(KEY_ID_DOMAIN), key))
}

/**
 * The next key after `current` (the brain's current key) and the args of the
 * team.rotate_key record that announces it: {epoch, key_id, prev}, prev the
 * current key sealed under the next one.
 */
export function rotateKey(set: MemberSet, current: BrainKey): { next: BrainKey, args: { epoch: number, key_id: string, prev: Box } } {
  return rotateKeyWith(sodium.randombytes_buf(KEY_BYTES), sodium.randombytes_buf(NONCE_BYTES), set, current)
}

/** rotateKey with a given key and nonce — for the test vectors. */
export function rotateKeyWith(key: Uint8Array, nonce: Uint8Array, set: MemberSet, current: BrainKey): { next: BrainKey, args: { epoch: number, key_id: string, prev: Box } } {
  if (current.epoch !== set.epoch || keyId(current.key) !== set.keys[set.epoch].key_id) throw new ProtocolError('the key to rotate is not the brain\'s current key')
  const next = { epoch: set.epoch + 1, key }
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(current.key, sodium.from_string(prevAad(set.brain, next.epoch)), null, nonce, next.key)
  return { next, args: { epoch: next.epoch, key_id: keyId(next.key), prev: { nonce: toBase64url(nonce), ct: toBase64url(ct) } } }
}

/**
 * Every key of the brain from epoch 0 to `newest`'s epoch, opened backwards
 * through the rotations' prev boxes, each checked against the id the log
 * names it by. Throws ProtocolError when a key is not the log's.
 */
export function epochKeys(set: MemberSet, newest: BrainKey): BrainKey[] {
  if (!Number.isSafeInteger(newest.epoch) || newest.epoch < 0 || newest.epoch > set.epoch) throw new ProtocolError(`the brain has no epoch ${newest.epoch}`)
  const keys = [newest]
  for (let epoch = newest.epoch; ; epoch--) {
    const key = keys[0].key
    if (keyId(key) !== set.keys[epoch].key_id) throw new ProtocolError(`the key of epoch ${epoch} is not the one the log names`)
    const prev = set.keys[epoch].prev
    if (!prev) return keys
    let older: Uint8Array
    try {
      older = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, fromBase64url(prev.ct, undefined, 'prev'), sodium.from_string(prevAad(set.brain, epoch)), fromBase64url(prev.nonce, NONCE_BYTES, 'prev.nonce'), key)
    } catch {
      throw new ProtocolError(`the prev of epoch ${epoch} does not open with its key`)
    }
    keys.unshift({ epoch: epoch - 1, key: older })
  }
}

/**
 * `key` wrapped for `recipient` (a current device's signing key; its
 * encryption key comes from its certificate in `set`), signed by `wrapper`.
 */
export function wrapKey(set: MemberSet, key: BrainKey, recipient: string, wrapper: KeyPair): WrappedKey {
  const member = memberOfDevice(set, recipient)
  if (!member) throw new ProtocolError('the recipient is not a current device of a member')
  if (key.key.length !== KEY_BYTES) throw new ProtocolError(`a brain key is ${KEY_BYTES} bytes`)
  const enc = fromBase64url(set.members[member].devices[recipient].device_enc, KEY_BYTES, 'the recipient\'s encryption key')
  const body = { v: 1 as const, brain: set.brain, epoch: key.epoch, recipient, sealed: toBase64url(sodium.crypto_box_seal(key.key, enc)), wrapper: wrapper.publicKey }
  return { ...body, sig: signText(wrapper, WRAP_DOMAIN, canonicalJson(body)) }
}

/**
 * The brain key in `record`, wrapped for `device`: exactly a wrapped-key
 * record of this brain, signed by a current device of an owner or of the
 * recipient's own member, for an epoch the log has reached, and the key the
 * log names for that epoch. Throws ProtocolError otherwise.
 */
export function unwrapKey(set: MemberSet, record: unknown, device: DeviceKeys): BrainKey {
  const r = asObject(record, 'a wrapped key')
  if (r.v !== 1) throw new UnsupportedVersionError(r.v)
  exactFields(r, ['v', 'brain', 'epoch', 'recipient', 'sealed', 'wrapper', 'sig'], 'a wrapped key')
  if (r.brain !== set.brain) throw new ProtocolError('the wrapped key is for another brain')
  if (r.recipient !== device.sign.publicKey) throw new ProtocolError('the wrapped key is for another device')
  if (!Number.isSafeInteger(r.epoch) || (r.epoch as number) < 0 || (r.epoch as number) > set.epoch) throw new ProtocolError(`the brain has no epoch ${String(r.epoch)}`)
  const wrapperMember = memberOfDevice(set, r.wrapper)
  if (!wrapperMember) throw new ProtocolError('the wrapper is not a current device of a member')
  if (set.members[wrapperMember].role !== 'owner' && wrapperMember !== memberOfDevice(set, r.recipient)) {
    throw new ProtocolError('a key is wrapped by an owner or by the recipient\'s own member')
  }
  const { sig, ...body } = r
  if (!verifyText(r.wrapper as string, WRAP_DOMAIN, canonicalJson(body), sig as string)) throw new ProtocolError('the wrapped key is not signed by its wrapper')
  const own = sodium.crypto_box_seed_keypair(device.enc.seed)
  let key: Uint8Array
  try {
    key = sodium.crypto_box_seal_open(fromBase64url(r.sealed, SEAL_BYTES, 'sealed'), own.publicKey, own.privateKey)
  } catch (err) {
    if (err instanceof ProtocolError) throw err
    throw new ProtocolError('the wrapped key does not open with this device\'s key')
  }
  if (keyId(key) !== set.keys[r.epoch as number].key_id) throw new ProtocolError(`the wrapped key is not the key the log names for epoch ${String(r.epoch)}`)
  return { epoch: r.epoch as number, key }
}

function prevAad(brain: string, epoch: number): string {
  return canonicalJson({ brain, epoch })
}
