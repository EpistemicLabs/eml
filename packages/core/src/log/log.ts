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
//
// A schema bump changes what the commands do, so a log is replayed within one
// schema only: the migration step states the brain's state after it as a
// checkpoint with a snapshot (writeCheckpoint, storeCheckpointSnapshot), and a
// rebuild starts from the latest snapshot of the schema the code replays.

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

/** True once the log has its genesis (seq 1); false for a brain still waiting for one from its relay. */
export function hasGenesis(db: Database.Database): boolean {
  return !!db.prepare('SELECT 1 FROM op_log WHERE seq = 1').get()
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

/** Namespace of a migration checkpoint's op_id (uuidv5): like a genesis, it draws no random id. */
const CHECKPOINT_NAMESPACE = '8b1e6f04-3a5d-4c27-9e1b-6d0a4f7c2e93'

/**
 * Writes the checkpoint of a migration step in a private brain: `brain.checkpoint`
 * at `schema` for the state as it is now — the state after the head entry, as
 * the new schema holds it — and that state as the snapshot at the checkpoint's
 * seq, what a rebuild at `schema` starts from. Its op_id is derived from the
 * brain, the schema, the time and the state, so the migration preflight and
 * the live run write the same entry. A shared brain's checkpoint goes through
 * its relay; a brain without a genesis has no log to continue. Returns whether
 * it wrote one.
 */
export function writeCheckpoint(db: Database.Database, schema: number, at: string): boolean {
  const head = headOf(db)
  if (!head || teamBrainOf(db) !== null) return false
  const dump = stateDump(db)
  const state_hash = stateHash(dump)
  const op: OpEnvelope = {
    op_id: uuidv5(CHECKPOINT_NAMESPACE, `${brainIdOf(db)}\n${schema}\n${at}\n${state_hash}`),
    schema,
    call: 'brain.checkpoint',
    args: { seq: head.seq, state_hash },
    provenance: { ...NO_ACTOR, ingestion_method: 'other' },
  }
  const { seq } = appendOp(db, op, at)
  db.prepare('INSERT INTO op_snapshots (seq, schema, state_hash, data) VALUES (?, ?, ?, ?)')
    .run(seq, schema, state_hash, encodeSnapshot(dump))
  return true
}

/** The schema of the latest snapshot — the schema the log was last replayed from — or null before a genesis. */
export function snapshotSchemaOf(db: Database.Database): number | null {
  const row = db.prepare('SELECT schema FROM op_snapshots ORDER BY seq DESC LIMIT 1').get() as { schema: number } | undefined
  return row?.schema ?? null
}

/**
 * A shared brain's side of a schema bump: the checkpoint entry at `seq`, just
 * appended, states the state after the entry before it at a schema above the
 * latest snapshot's. When this replica's state is the one it names, that state
 * becomes the snapshot at `seq`. Returns whether it stored one.
 */
export function storeCheckpointSnapshot(db: Database.Database, seq: number, op: OpEnvelope): boolean {
  const args = op.args as { seq?: unknown, state_hash?: unknown }
  const latest = snapshotSchemaOf(db)
  if (op.call !== 'brain.checkpoint' || args.seq !== seq - 1 || latest === null || op.schema <= latest) return false
  const dump = stateDump(db)
  const state_hash = stateHash(dump)
  if (state_hash !== args.state_hash) return false
  db.prepare('INSERT INTO op_snapshots (seq, schema, state_hash, data) VALUES (?, ?, ?, ?)')
    .run(seq, op.schema, state_hash, encodeSnapshot(dump))
  return true
}
