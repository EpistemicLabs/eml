import type Database from 'better-sqlite3'
import { GENESIS_PREV_HASH, chainHash, plainJson, sha256Hex, type OpEnvelope } from '@engramprotocol/protocol/log'
import { NO_ACTOR } from '../env'
import { uuidv5 } from './op'
import { encodeSnapshot, stateDump, stateHash } from './snapshot'

// --- The op log (v0.21) ----------------------------------------------------------
//
// op_log and op_snapshots in the brain file (schema 21). Appending runs inside
// the caller's transaction; an entry, once written, is never changed. A private
// brain sequences its own writes (appendOp); a shared brain takes every entry
// in the order and at the time its relay gave it (appendRelayed).

/**
 * Appends `op` as the next entry of the chain. Its time is `now`, or the head
 * entry's time when the clock went back — the log's times never decrease.
 * Returns the entry's seq, time and payload as stored.
 */
export function appendOp(db: Database.Database, op: OpEnvelope, now: string): { seq: number, at: string, payload: string } {
  const head = headOf(db)
  const seq = (head?.seq ?? 0) + 1
  const at = head && head.at > now ? head.at : now
  const payload = plainJson(op)  // the envelope in the caller's key order: the bytes stored, hashed and run
  insertEntry(db, head, { seq, at, op_id: op.op_id, payload, signature: null, rejected: null })
  return { seq, at, payload }
}

/** An entry as a shared brain's relay delivered it, with what this replica found. */
export interface RelayedEntry {
  seq: number
  at: string
  /** null only for a rejected record that names no valid op_id */
  op_id: string | null
  /** the op's payload as signed; for a record that did not open, canonicalJson of the record */
  payload: string
  signature: Buffer | null
  /** null when applied; else why this replica refused it (decision shared-log-rejected-entries) */
  rejected: string | null
}

/** A relayed entry out of order: not the next seq, or earlier than the head — the replica stops. */
export class RelayOrderError extends Error {
  constructor(readonly seq: number, message: string) {
    super(`relayed entry ${seq}: ${message}`)
    this.name = 'RelayOrderError'
  }
}

/**
 * Appends an entry of a shared brain at the seq and time its relay gave it:
 * the next seq, and no earlier than the head (the relay keeps its time
 * monotone; a replica that sees it go back stops). Runs inside the caller's
 * transaction, together with applying the entry.
 */
export function appendRelayed(db: Database.Database, entry: RelayedEntry): void {
  const head = headOf(db)
  const next = (head?.seq ?? 0) + 1
  if (entry.seq !== next) throw new RelayOrderError(entry.seq, `the log expects seq ${next}`)
  if (head && entry.at < head.at) throw new RelayOrderError(entry.seq, `its time ${entry.at} is before the head's ${head.at}`)
  insertEntry(db, head, entry)
}

type Head = { seq: number, at: string, hash: string } | undefined

function headOf(db: Database.Database): Head {
  return db.prepare('SELECT seq, at, hash FROM op_log ORDER BY seq DESC LIMIT 1').get() as Head
}

/** Writes `entry` after `head`: its payload hash and its chain link. */
function insertEntry(db: Database.Database, head: Head, entry: RelayedEntry): void {
  const prevHash = head?.hash ?? GENESIS_PREV_HASH
  const payloadHash = sha256Hex(entry.payload)
  db.prepare(`INSERT INTO op_log (seq, at, op_id, prev_hash, payload_hash, hash, signature, rejected, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(entry.seq, entry.at, entry.op_id, prevHash, payloadHash, chainHash(prevHash, entry.seq, entry.at, payloadHash), entry.signature, entry.rejected, entry.payload)
}

/** The brain's own id, as its genesis carries it (args.brain), or null before a genesis. */
export function brainIdOf(db: Database.Database): string | null {
  const genesis = db.prepare('SELECT payload FROM op_log WHERE seq = 1').get() as { payload: string } | undefined
  return genesis ? ((JSON.parse(genesis.payload) as OpEnvelope).args as { brain?: string }).brain ?? null : null
}

/** The team brain a log belongs to — its genesis's team.brain — or null for a private brain. */
export function teamBrainOf(db: Database.Database): string | null {
  const genesis = db.prepare('SELECT payload FROM op_log WHERE seq = 1').get() as { payload: string } | undefined
  return genesis ? ((JSON.parse(genesis.payload) as OpEnvelope).team?.brain ?? null) : null
}

/** True when the brain has an op log without entries — a brain that just reached schema 21. */
export function needsGenesis(db: Database.Database): boolean {
  const hasLog = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'op_log'`).get()
  return hasLog && !db.prepare('SELECT 1 FROM op_log LIMIT 1').get()
}

/** Namespace of the genesis op_id (uuidv5): a genesis draws no random id. */
const GENESIS_NAMESPACE = '5d3c8e2a-7f41-4b9e-a6d0-2c1f9b8e4a70'
const BRAIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Writes seq 1: `brain.genesis` with the brain's id and the hash of its state
 * as it is now, and that state as the snapshot at seq 1 — what a rebuild
 * starts from. Its op_id is derived from the id, the time and the state, so
 * the migration preflight and the live run write the same genesis, and two
 * brains never share one.
 */
export function writeGenesis(db: Database.Database, schema: number, at: string, brain: string): void {
  if (!BRAIN_ID.test(brain)) throw new Error(`a brain id is a lowercase UUID, not "${brain}"`)
  const dump = stateDump(db)
  const state_hash = stateHash(dump)
  const op: OpEnvelope = {
    op_id: uuidv5(GENESIS_NAMESPACE, `${brain}\n${at}\n${state_hash}`),
    schema,
    call: 'brain.genesis',
    args: { brain, state_hash },
    provenance: { ...NO_ACTOR, ingestion_method: 'other' },
  }
  const { seq } = appendOp(db, op, at)
  db.prepare('INSERT INTO op_snapshots (seq, schema, state_hash, data) VALUES (?, ?, ?, ?)')
    .run(seq, schema, state_hash, encodeSnapshot(dump))
}
