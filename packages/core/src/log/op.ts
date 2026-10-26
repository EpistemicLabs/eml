import { createHash } from 'crypto'
import type { Actor, IdSource } from '../env'
import { canonicalJson, type Json } from './canonical'

// --- Ops (v0.21) -----------------------------------------------------------------
//
// Every brain write is an op in the brain's log (decision
// team-brain-op-log-write-path; spec local-op-log-spec). The payload is the
// canonical JSON of the envelope — what the writer intends, never what the
// brain derives — and the log chains the entries: each link hashes the previous
// link, the entry's position and time (set by the sequencer, not the author;
// decision op-log-chain-covers-seq-and-time) and the payload's hash.

/** An op as written: a call with its args, by whom, against which brain schema. */
export interface OpEnvelope {
  op_id: string
  schema: number
  call: string
  args: Json
  provenance: Actor
}

/** prev_hash of the first entry (genesis). */
export const GENESIS_PREV_HASH = '0'.repeat(64)

const HASH = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The payload an entry stores and hashes: the envelope as canonical JSON. */
export function encodePayload(op: OpEnvelope): string {
  return canonicalJson(op)
}

/** sha256 of the payload's UTF-8 bytes, hex. */
export function payloadHash(payload: string): string {
  return sha256Hex(payload)
}

/**
 * The chain link of entry `seq`: sha256 over the UTF-8 text
 * `<prev_hash>\n<seq>\n<at>\n<payload_hash>` (hashes as lowercase hex, seq in
 * decimal, at as ISO-8601 UTC ms). None of the parts can hold a newline, so
 * the text is unambiguous.
 */
export function chainHash(prevHash: string, seq: number, at: string, payloadHashHex: string): string {
  if (!HASH.test(prevHash) || !HASH.test(payloadHashHex)) throw new Error('chainHash: hashes are 64 lowercase hex digits')
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('chainHash: seq is a positive integer')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)) throw new Error('chainHash: at is ISO-8601 UTC with milliseconds')
  return sha256Hex(`${prevHash}\n${seq}\n${at}\n${payloadHashHex}`)
}

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
