import Database from 'better-sqlite3'
import { GENESIS_PREV_HASH, canonicalJson, chainHash, sha256Hex, type OpEnvelope } from '@engramprotocol/protocol/log'
import { EML } from '../index'
import { CURRENT_BRAIN_SCHEMA_VERSION } from '../control'
import { currentSchemaSql } from '../database'
import { applyOp, commandStores } from './apply-op'
import { teamBrainOf } from './log'
import { decodeSnapshot, stateDump, stateHash, type StateDump } from './snapshot'

// --- Rebuild and verify (v0.21) --------------------------------------------------
//
// A brain is its log: the genesis snapshot and every op after it, applied as
// stored at its time, give the brain's state again. verify() checks that for
// a brain — the chain first, then a rebuild compared with the live state.
// Both only read the brain they are given.

/** A replay that cannot go on: the entry, and why. */
export class ReplayError extends Error {
  constructor(readonly seq: number, message: string) {
    super(`op ${seq}: ${message}`)
    this.name = 'ReplayError'
  }
}

/**
 * Rebuilds the state of `source` into `into` (an empty database): the current
 * schema, the genesis snapshot, then every later applied op through applyOp
 * with its stored payload and time (a rejected entry changed nothing). `into`
 * gets the state, not the log.
 */
export function rebuild(into: Database.Database, source: Database.Database): void {
  const genesis = source.prepare('SELECT schema, data FROM op_snapshots WHERE seq = 1').get() as { schema: number, data: Buffer } | undefined
  if (!genesis) throw new ReplayError(1, 'no genesis snapshot')
  if (genesis.schema !== CURRENT_BRAIN_SCHEMA_VERSION) throw new ReplayError(1, `the genesis is schema ${genesis.schema}; this code replays schema ${CURRENT_BRAIN_SCHEMA_VERSION}`)

  into.exec(currentSchemaSql())
  // the snapshot's rows go in as they are, with foreign keys off (tables load
  // by name, not by reference); the replay then runs with them on, as a live write does
  into.pragma('foreign_keys = OFF')
  into.transaction(() => loadState(into, decodeSnapshot(genesis.data)))()
  into.pragma('foreign_keys = ON')

  const stores = commandStores(EML.fromConnection(into, 'rebuild'), into)
  const teamBrain = teamBrainOf(source)
  const entries = source.prepare('SELECT seq, at, payload FROM op_log WHERE seq > 1 AND rejected IS NULL ORDER BY seq').iterate() as IterableIterator<{ seq: number, at: string, payload: string }>
  into.transaction(() => {
    for (const entry of entries) {
      const op = JSON.parse(entry.payload) as OpEnvelope
      if (op.schema !== CURRENT_BRAIN_SCHEMA_VERSION) throw new ReplayError(entry.seq, `the op is schema ${op.schema}; this code replays schema ${CURRENT_BRAIN_SCHEMA_VERSION}`)
      try {
        applyOp(stores, op, entry.at, teamBrain)
      } catch (err) {
        throw new ReplayError(entry.seq, `${op.call} failed on replay: ${(err as Error).message}`)
      }
    }
  })()
}

function loadState(db: Database.Database, dump: StateDump): void {
  for (const [table, rows] of Object.entries(dump)) {
    for (const row of rows) {
      const cols = Object.keys(row)
      db.prepare(`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map(c => row[c]))
    }
  }
}

export type VerifyResult =
  | { ok: true, entries: number, state_hash: string }
  | { ok: false, problem: string, seq?: number, table?: string }

/**
 * Checks a brain against its log: every entry in order without gaps, each
 * payload against its hash and each chain link (rejected entries included —
 * they are in the chain); the genesis against its
 * snapshot; then a rebuild into memory, compared table by table with the live
 * state. Returns ok with the state hash, or the first problem found.
 */
export function verify(db: Database.Database): VerifyResult {
  const entries = db.prepare('SELECT seq, at, op_id, prev_hash, payload_hash, hash, payload FROM op_log ORDER BY seq').all() as Array<{ seq: number, at: string, op_id: string | null, prev_hash: string, payload_hash: string, hash: string, payload: string }>
  if (entries.length === 0) return { ok: false, problem: 'the log is empty' }

  let prev = GENESIS_PREV_HASH
  for (const [i, e] of entries.entries()) {
    const seq = i + 1
    if (e.seq !== seq) return { ok: false, seq, problem: `entry ${seq} is missing (the next one is ${e.seq})` }
    if (e.prev_hash !== prev) return { ok: false, seq, problem: 'prev_hash is not the previous entry\'s link' }
    if (e.payload_hash !== sha256Hex(e.payload)) return { ok: false, seq, problem: 'the payload does not match its payload_hash' }
    // a rejected record that names no valid op_id is logged without one (the schema allows it only there)
    if (e.op_id !== null && e.op_id !== (JSON.parse(e.payload) as OpEnvelope).op_id) return { ok: false, seq, problem: 'op_id is not the payload\'s op_id' }
    let link: string
    try { link = chainHash(e.prev_hash, e.seq, e.at, e.payload_hash) } catch (err) { return { ok: false, seq, problem: (err as Error).message } }
    if (e.hash !== link) return { ok: false, seq, problem: 'the chain link does not match its seq, at and hashes' }
    prev = e.hash
  }

  const genesis = JSON.parse(entries[0].payload) as OpEnvelope
  const snapshot = db.prepare('SELECT state_hash, data FROM op_snapshots WHERE seq = 1').get() as { state_hash: string, data: Buffer } | undefined
  if (genesis.call !== 'brain.genesis') return { ok: false, seq: 1, problem: `the first entry is ${genesis.call}, not the genesis` }
  if (!snapshot) return { ok: false, seq: 1, problem: 'no genesis snapshot' }
  const genesisHash = (genesis.args as { state_hash?: string }).state_hash
  if (snapshot.state_hash !== genesisHash || stateHash(decodeSnapshot(snapshot.data)) !== genesisHash) {
    return { ok: false, seq: 1, problem: 'the genesis snapshot does not match the genesis state_hash' }
  }

  const rebuilt = new Database(':memory:')
  try {
    try { rebuild(rebuilt, db) } catch (err) {
      if (err instanceof ReplayError) return { ok: false, seq: err.seq, problem: err.message }
      throw err
    }
    const live = stateDump(db)
    const again = stateDump(rebuilt)
    for (const table of [...new Set([...Object.keys(live), ...Object.keys(again)])].sort()) {
      if (canonicalJson(live[table] ?? null) !== canonicalJson(again[table] ?? null)) {
        return { ok: false, table, problem: `the rebuilt ${table} differs from the live brain` }
      }
    }
    return { ok: true, entries: entries.length, state_hash: stateHash(live) }
  } finally {
    rebuilt.close()
  }
}
