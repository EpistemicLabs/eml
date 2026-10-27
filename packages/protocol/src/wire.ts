import sodium from 'libsodium-wrappers'
import { HASH } from './op'

// --- On the wire (v0.21) ---------------------------------------------------------
//
// What every part of the protocol shares: libsodium, the errors, the version,
// the text forms of ids, times and bytes, the sizes, and the strict readers.
// Every primitive is a standard libsodium construction (libsodium-wrappers,
// WebAssembly), so any libsodium binding can check it. The library loads
// asynchronously: await ready() once before the first call.

/** Resolves once libsodium is loaded; every key, signature and seal needs it. */
export function ready(): Promise<void> {
  return sodium.ready
}

export { sodium }

/** A protocol object that is malformed, forged or not allowed here. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

/** A protocol object of a version this code does not know: the replica stops and asks for an update. */
export class UnsupportedVersionError extends ProtocolError {
  constructor(readonly v: unknown) {
    super(`protocol version ${String(v)} is not supported by this version`)
    this.name = 'UnsupportedVersionError'
  }
}

/** The protocol version every record, message, link and signature tag carries. */
export const PROTOCOL_VERSION: 1 = 1

/** Throws UnsupportedVersionError unless `v` is this protocol's version — checked before anything else of an object. */
export function checkVersion(v: unknown): void {
  if (v !== PROTOCOL_VERSION) throw new UnsupportedVersionError(v)
}

export { HASH }
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** Keys and seeds (Ed25519, X25519, brain keys, derived keys). */
export const KEY_BYTES = 32
/** XChaCha20-Poly1305 nonces. */
export const NONCE_BYTES = 24
/** Poly1305 tags. */
export const TAG_BYTES = 16
/** Ed25519 signatures. */
export const SIG_BYTES = 64

/** Bytes as base64url without padding — the protocol's text form of keys, signatures and nonces. */
export function toBase64url(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING)
}

/**
 * The bytes of `text`, which must be base64url without padding and, when
 * `length` is given, exactly that many bytes. libsodium's decoder refuses
 * padding, other alphabets, whitespace and non-zero trailing bits, so a key
 * or signature has one text form. `what` names it in the error.
 */
export function fromBase64url(text: unknown, length: number | undefined, what: string): Uint8Array {
  let bytes: Uint8Array
  try {
    if (typeof text !== 'string') throw new Error()
    bytes = sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING)
  } catch {
    throw new ProtocolError(`${what} is not base64url`)
  }
  if (length !== undefined && bytes.length !== length) throw new ProtocolError(`${what} is ${bytes.length} bytes, not ${length}`)
  return bytes
}

/** Throws unless `value` has exactly `fields` — a protocol object never carries a field this version does not know. */
export function exactFields(value: object, fields: string[], what: string): void {
  const keys = Object.keys(value)
  const extra = keys.filter(k => !fields.includes(k))
  if (extra.length > 0) throw new ProtocolError(`${what} has no field ${extra.join(', ')}`)
  const missing = fields.filter(k => !keys.includes(k))
  if (missing.length > 0) throw new ProtocolError(`${what} lacks ${missing.join(', ')}`)
}

/** `value` as an object with fields, or ProtocolError naming `what`. */
export function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProtocolError(`${what} is an object`)
  return value as Record<string, unknown>
}

/**
 * Opens an XChaCha20-Poly1305 box — ciphertext and nonce as base64url —
 * under `key` with `aad`; ProtocolError(`failure`) when it does not open.
 */
export function openBox(ct: unknown, nonce: unknown, aad: string, key: Uint8Array, failure: string): Uint8Array {
  const c = fromBase64url(ct, undefined, 'the ciphertext')
  const n = fromBase64url(nonce, NONCE_BYTES, 'the nonce')
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, c, sodium.from_string(aad), n, key)
  } catch {
    throw new ProtocolError(failure)
  }
}

/** Seals `plain` with XChaCha20-Poly1305 under `key` with `aad` and the given nonce: the box as base64url. */
export function sealBox(plain: Uint8Array, aad: string, nonce: Uint8Array, key: Uint8Array): { nonce: string, ct: string } {
  if (nonce.length !== NONCE_BYTES) throw new ProtocolError(`a nonce is ${NONCE_BYTES} bytes`)
  return { nonce: toBase64url(nonce), ct: toBase64url(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, sodium.from_string(aad), null, nonce, key)) }
}

/** `bytes` as UTF-8 text, refusing anything that is not exactly UTF-8. */
export function utf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new ProtocolError(`${what} is not UTF-8`)
  }
}
