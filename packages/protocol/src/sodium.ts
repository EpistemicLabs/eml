import sodium from 'libsodium-wrappers'

// --- libsodium (v0.21) -----------------------------------------------------------
//
// Every primitive of the protocol is a standard libsodium construction
// (libsodium-wrappers, WebAssembly), so any libsodium binding can check it.
// The library loads asynchronously: await ready() once before the first call.

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
