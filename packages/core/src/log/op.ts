import { createHash } from 'crypto'
import type { IdSource } from '../env'

// --- Op ids (v0.21) --------------------------------------------------------------
//
// The op envelope, the chain and the payload hash are protocol
// (@engramprotocol/protocol). What stays here is how a replica runs an op: the
// ids it draws are derived from the op_id, so every replay draws the same.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** RFC 9562 §5.5: the name-based UUID (SHA-1) of `name` in `namespace`. */
export function uuidv5(namespace: string, name: string): string {
  if (!UUID.test(namespace)) throw new Error(`uuidv5: namespace must be a UUID, got "${namespace}"`)
  const digest = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
  const b = digest.subarray(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50  // version 5
  b[8] = (b[8] & 0x3f) | 0x80  // variant 10
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The ids an op draws: uuidv5(op_id, "0"), uuidv5(op_id, "1"), … — the same on every replay. */
export function opIds(opId: string): IdSource {
  let n = 0
  return () => uuidv5(opId, String(n++))
}
