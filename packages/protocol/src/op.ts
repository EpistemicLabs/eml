import { createHash } from 'crypto'
import type { Json } from './canonical'

// --- Ops (v0.21) -----------------------------------------------------------------
//
// Every brain write is an op in the brain's log (decision
// team-brain-op-log-write-path; spec local-op-log-spec). The payload is the
// envelope as JSON in the caller's key order — what the writer intends, never
// what the brain derives — and the log chains the entries: each link hashes
// the previous link, the entry's position and time (set by the sequencer, not
// the author; decision op-log-chain-covers-seq-and-time) and the payload's hash.

/** Who wrote an op: stamped on every engram and entry it writes (attribution only). */
export interface Provenance {
  handle: string | null
  ingestion_method: string | null
  session_id: string | null
  model: string | null
  harness: string | null
}

/** An op as written: a call with its args, by whom, against which brain schema. */
export interface OpEnvelope {
  op_id: string
  schema: number
  call: string
  args: Json
  provenance: Provenance
}

/** prev_hash of the first entry (genesis). */
export const GENESIS_PREV_HASH = '0'.repeat(64)

const HASH = /^[0-9a-f]{64}$/

/** sha256, hex; a string is hashed as its UTF-8 bytes (a payload's hash is sha256Hex(payload)). */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
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
