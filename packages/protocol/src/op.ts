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

/**
 * Who wrote an op: stamped on every engram and entry it writes (attribution
 * only). handle is who is accountable (in a shared brain the member); agent is
 * the agent that wrote for them, null when they wrote themself (decision
 * provenance-agent-field).
 */
export interface Provenance {
  handle: string | null
  agent: string | null
  ingestion_method: string | null
  session_id: string | null
  model: string | null
  harness: string | null
}

/**
 * What an op in a shared brain carries besides the F2 fields: the brain it is
 * for, the author's device signing key, and the author's last applied entry
 * with its chain link (spec team-brain-protocol-package-spec §2a).
 */
export interface TeamFields {
  brain: string
  device: string
  base_seq: number
  head_hash: string
}

/** An op as written: a call with its args, by whom, against which brain schema; in a shared brain also its team fields. */
export interface OpEnvelope {
  op_id: string
  schema: number
  call: string
  args: Json
  provenance: Provenance
  team?: TeamFields
}

const PROVENANCE_FIELDS = ['handle', 'agent', 'ingestion_method', 'session_id', 'model', 'harness']

/**
 * What is wrong with `value` as a provenance — exactly the six fields, each
 * a string or null — or null when nothing is. Its values (which ingestion
 * methods exist) are the brain schema's to check.
 */
export function provenanceProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'provenance is not an object'
  const keys = Object.keys(value)
  if (keys.length !== PROVENANCE_FIELDS.length || !PROVENANCE_FIELDS.every(k => keys.includes(k))) {
    return `provenance has the fields ${keys.join(', ')}, not ${PROVENANCE_FIELDS.join(', ')}`
  }
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v !== 'string') return `provenance.${k} is neither a string nor null`
  }
  return null
}

/** prev_hash of the first entry (genesis). */
export const GENESIS_PREV_HASH = '0'.repeat(64)

/** A SHA-256 hash in its text form: 64 lowercase hex digits. */
export const HASH = /^[0-9a-f]{64}$/

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
