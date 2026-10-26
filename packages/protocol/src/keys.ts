import { createHash } from 'crypto'
import { canonicalJson } from './canonical'
import { ProtocolError, asObject, exactFields, fromBase64url, sodium, toBase64url } from './sodium'

// --- Keys and device certificates (v0.21) ----------------------------------------
//
// A member of a team brain has an identity key (Ed25519), made on their first
// device and kept there; it certifies each of the member's devices. A device
// has a signing key (Ed25519: ops, records, login) and an encryption key
// (X25519: receives the brain key). Keys are per team brain, and their private
// parts never leave the device (decision team-brain-device-keys-invite-link;
// spec team-brain-protocol-package-spec §3).

/** A key pair as the device keeps it: the 32-byte seed is the secret, the public key its text form. */
export interface KeyPair {
  publicKey: string
  seed: Uint8Array
}

/** A device's two key pairs. */
export interface DeviceKeys {
  sign: KeyPair
  enc: KeyPair
}

/** A device certificate: the member's identity key vouches for the device's two public keys in one brain. */
export interface DeviceCert {
  v: 1
  brain: string
  member: string
  device_sign: string
  device_enc: string
  created_at: string
  sig: string
}

const DEVICE_CERT_DOMAIN = 'eml-device-cert-v1\n'
const SEED_BYTES = 32
const KEY_BYTES = 32
const SIG_BYTES = 64
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** A new Ed25519 key pair — a member's identity key or a device's signing key. */
export function newSigningKey(): KeyPair {
  return signingKeyFromSeed(sodium.randombytes_buf(SEED_BYTES))
}

/** The Ed25519 key pair of `seed` (RFC 8032: the seed is the private key). */
export function signingKeyFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== SEED_BYTES) throw new ProtocolError(`a seed is ${SEED_BYTES} bytes`)
  return { publicKey: toBase64url(sodium.crypto_sign_seed_keypair(seed).publicKey), seed }
}

/** A new X25519 key pair — a device's encryption key. */
export function newEncryptionKey(): KeyPair {
  return encryptionKeyFromSeed(sodium.randombytes_buf(SEED_BYTES))
}

/** The X25519 key pair of `seed` (libsodium crypto_box_seed_keypair: the private key is the first half of SHA-512(seed)). */
export function encryptionKeyFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== SEED_BYTES) throw new ProtocolError(`a seed is ${SEED_BYTES} bytes`)
  return { publicKey: toBase64url(sodium.crypto_box_seed_keypair(seed).publicKey), seed }
}

/** A new device: its signing and its encryption key. */
export function newDeviceKeys(): DeviceKeys {
  return { sign: newSigningKey(), enc: newEncryptionKey() }
}

/** Ed25519 over `domain` + `text` (UTF-8), base64url. Every signature in the protocol names what it signs in its domain. */
export function signText(key: KeyPair, domain: string, text: string): string {
  return toBase64url(sodium.crypto_sign_detached(sodium.from_string(domain + text), sodium.crypto_sign_seed_keypair(key.seed).privateKey))
}

/** True when `sig` is `publicKey`'s Ed25519 signature over `domain` + `text`; throws on a malformed key or signature. */
export function verifyText(publicKey: string, domain: string, text: string, sig: string): boolean {
  return sodium.crypto_sign_verify_detached(
    fromBase64url(sig, SIG_BYTES, 'the signature'),
    sodium.from_string(domain + text),
    fromBase64url(publicKey, KEY_BYTES, 'the public key'),
  )
}

/**
 * The certificate of a device in `brain`, signed by the member's identity
 * key. `created_at` is the caller's time (ISO-8601 UTC with milliseconds).
 */
export function certifyDevice(identity: KeyPair, fields: { brain: string, device_sign: string, device_enc: string, created_at: string }): DeviceCert {
  const body = { v: 1 as const, brain: fields.brain, member: identity.publicKey, device_sign: fields.device_sign, device_enc: fields.device_enc, created_at: fields.created_at }
  checkCertBody(body)
  return { ...body, sig: signText(identity, DEVICE_CERT_DOMAIN, canonicalJson(body)) }
}

/**
 * `value` as a device certificate, when it is exactly one — the fields and
 * nothing else, each well-formed — and its signature is the member's. Throws
 * ProtocolError otherwise.
 */
export function verifyDeviceCert(value: unknown): DeviceCert {
  exactFields(asObject(value, 'a device certificate'), ['v', 'brain', 'member', 'device_sign', 'device_enc', 'created_at', 'sig'], 'a device certificate')
  const { sig, ...body } = value as DeviceCert
  checkCertBody(body)
  if (!verifyText(body.member, DEVICE_CERT_DOMAIN, canonicalJson(body), sig)) throw new ProtocolError('the device certificate is not signed by its member')
  return value as DeviceCert
}

function checkCertBody(body: Omit<DeviceCert, 'sig'>): void {
  if (body.v !== 1) throw new ProtocolError(`device certificate version ${String(body.v)} is not supported`)
  if (typeof body.brain !== 'string' || !UUID.test(body.brain)) throw new ProtocolError('the brain is not a lowercase UUID')
  fromBase64url(body.member, KEY_BYTES, 'the member key')
  fromBase64url(body.device_sign, KEY_BYTES, 'the device signing key')
  fromBase64url(body.device_enc, KEY_BYTES, 'the device encryption key')
  if (typeof body.created_at !== 'string' || !ISO_MS.test(body.created_at)) throw new ProtocolError('created_at is not ISO-8601 UTC with milliseconds')
}

/**
 * What an owner compares when confirming a join: the first 20 bytes of
 * sha256 over the identity public key's bytes, as 8 groups of 5 hex digits.
 */
export function fingerprint(publicKey: string): string {
  const hex = createHash('sha256').update(fromBase64url(publicKey, KEY_BYTES, 'the public key')).digest('hex').slice(0, 40)
  return hex.match(/.{5}/g)!.join(' ')
}
