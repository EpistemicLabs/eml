import type Database from 'better-sqlite3'
import { gzipSync, gunzipSync } from 'zlib'
import { canonicalJson } from './canonical'
import { sha256Hex } from './op'

// --- State dump and snapshots (v0.21) --------------------------------------------
//
// A brain's state as data: every state table, rows ordered by primary key. It
// is what a rebuild from the log is compared with, what the state hash covers
// and what a snapshot stores. Not state: the migration ledger (applied_at is
// when this copy migrated), the log and its snapshots, and the FTS shadow
// tables (the fts table itself is state, with its rowid, so a rebuilt brain
// ranks ties the same). A table added later is state unless listed here.

const NOT_STATE = new Set(['_eml_migrations', 'op_log', 'op_snapshots'])

export type StateRow = Record<string, unknown>
export type StateDump = Record<string, StateRow[]>

/** Every state table (by name) with its rows, ordered by primary key (rowid where a table declares none). */
export function stateDump(db: Database.Database): StateDump {
  const tables = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'engrams_fts_%' ORDER BY name`,
  ).all() as Array<{ name: string }>)
    .map(r => r.name)
    .filter(n => !NOT_STATE.has(n))
  const dump: StateDump = {}
  for (const table of tables) {
    const pk = (db.prepare(`SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`).all(table) as Array<{ name: string }>)
      .map(c => `"${c.name}"`)
    dump[table] = pk.length > 0
      ? db.prepare(`SELECT * FROM "${table}" ORDER BY ${pk.join(', ')}`).all() as StateRow[]
      : db.prepare(`SELECT rowid AS rowid, * FROM "${table}" ORDER BY rowid`).all() as StateRow[]
  }
  return dump
}

/** sha256 of the dump as canonical JSON, hex — equal states, equal hashes. */
export function stateHash(dump: StateDump): string {
  return sha256Hex(canonicalJson(dump))
}

/** A snapshot's stored form: the dump as gzipped canonical JSON (the hash covers the JSON, not these bytes). */
export function encodeSnapshot(dump: StateDump): Buffer {
  return gzipSync(canonicalJson(dump))
}

export function decodeSnapshot(data: Buffer): StateDump {
  return JSON.parse(gunzipSync(data).toString('utf-8')) as StateDump
}
