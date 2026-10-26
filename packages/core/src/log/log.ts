import type Database from 'better-sqlite3'
import { GENESIS_PREV_HASH, chainHash, plainJson, sha256Hex, type OpEnvelope } from '@engramprotocol/protocol/log'
import { NO_ACTOR } from '../env'
import { uuidv5 } from './op'
import { encodeSnapshot, stateDump, stateHash } from './snapshot'

// --- The op log (v0.21) ----------------------------------------------------------
//
// op_log and op_snapshots in the brain file (schema 21). Appending runs inside
// the caller's transaction; an entry, once written, is never changed.

/**
 * Appends `op` as the next entry of the chain. Its time is `now`, or the head
 * entry's time when the clock went back — the log's times never decrease.
 * Returns the entry's seq, time and payload as stored.
 */
export function appendOp(db: Database.Database, op: OpEnvelope, now: string): { seq: number, at: string, payload: string } {
  const head = db.prepare('SELECT seq, at, hash FROM op_log ORDER BY seq DESC LIMIT 1').get() as { seq: number, at: string, hash: string } | undefined
  const seq = (head?.seq ?? 0) + 1
  const at = head && head.at > now ? head.at : now
  const prevHash = head?.hash ?? GENESIS_PREV_HASH
  const payload = plainJson(op)  // the envelope in the caller's key order: the bytes stored, hashed and run
  const payloadHash = sha256Hex(payload)
  db.prepare(`INSERT INTO op_log (seq, at, op_id, prev_hash, payload_hash, hash, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(seq, at, op.op_id, prevHash, payloadHash, chainHash(prevHash, seq, at, payloadHash), payload)
  return { seq, at, payload }
}

/** True when the brain has an op log without entries — a brain that just reached schema 21. */
export function needsGenesis(db: Database.Database): boolean {
  const hasLog = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'op_log'`).get()
  return hasLog && !db.prepare('SELECT 1 FROM op_log LIMIT 1').get()
}

/** Namespace of the genesis op_id (uuidv5): a genesis draws no random id. */
const GENESIS_NAMESPACE = '5d3c8e2a-7f41-4b9e-a6d0-2c1f9b8e4a70'

/**
 * Writes seq 1: `brain.genesis` with the hash of the brain's state as it is
 * now, and that state as the snapshot at seq 1 — what a rebuild starts from.
 * Its op_id is derived from the time and the state, so the migration
 * preflight and the live run write the same genesis.
 */
export function writeGenesis(db: Database.Database, schema: number, at: string): void {
  const dump = stateDump(db)
  const state_hash = stateHash(dump)
  const op: OpEnvelope = {
    op_id: uuidv5(GENESIS_NAMESPACE, `${at}\n${state_hash}`),
    schema,
    call: 'brain.genesis',
    args: { state_hash },
    provenance: { ...NO_ACTOR, ingestion_method: 'other' },
  }
  const { seq } = appendOp(db, op, at)
  db.prepare('INSERT INTO op_snapshots (seq, schema, state_hash, data) VALUES (?, ?, ?, ?)')
    .run(seq, schema, state_hash, encodeSnapshot(dump))
}
