import type Database from 'better-sqlite3'
import { CommandError } from '../commands/types'
import { scopeObject } from '../validate'
import { canonicalJson, sha256Hex, type OpEnvelope } from '@engramprotocol/protocol/log'

// --- Moving engrams between brains (v0.21) ---------------------------------------
//
// A set of engrams leaves one brain and arrives in another with its history
// (spec cross-brain-move-spec; decision team-brain-move-project-as-import).
//
// What moves: the engrams as stored (ids, authorship, times, rev), their
// entries, the relations inside the set, their tag and subject links, and the
// registry rows they need — scope objects (a project with its parents), tags
// and subjects. ord is not carried; the target appends the rows in their source
// order. What does not: relations crossing the set (dropped in the source, and
// the caller names them) and entries naming an engram on the other side of the
// set's edge, either way (kept, the id stays as text). The source keeps its
// registry rows; the target keeps the ones it has and creates the rest.
//
// Two ops, one in each brain's log, so a rebuild replays and verify checks
// them like any write: engram.import writes the rows into the target, refused
// whole on any collision; engram.move_out removes the set from the source,
// only while the set's own rows are exactly what was imported (set_hash, which
// leaves out the registry rows: they stay in the source) — the removal is an
// op, not a delete (decision no-delete-command).
//
// moveEngrams (move-engrams.ts) runs them: the source is backed up first
// (backupBrain, the user's way back), then locked; the import commits in the
// target, then the move_out in the source. A failure between the two commits
// leaves the set in both brains, never in neither; the same move called again
// finds its import in the target's log and writes only the move_out.
//
// Not reachable by agents: no route and no MCP tool calls these.

/** The columns carried per table, in insert order of the tables: every stored column but ord. */
export const MOVED_COLUMNS = {
  projects: ['id', 'name', 'status', 'goal', 'description', 'owner', 'parent_project', 'started_at', 'ended_at', 'metadata', 'status_tracks', 'created_at', 'updated_at'],
  entities: ['id', 'name', 'kind', 'status', 'description', 'metadata', 'status_tracks', 'created_at', 'updated_at'],
  users: ['id', 'name', 'email', 'description', 'metadata', 'created_at', 'updated_at'],
  agents: ['id', 'name', 'parent_id', 'domains', 'description', 'metadata', 'created_at'],
  tags: ['id', 'name', 'description', 'status', 'created_at'],
  subjects: ['id', 'name', 'description', 'status', 'created_at', 'updated_at'],
  engrams: ['id', 'type', 'scope', 'title', 'content', 'status', 'significance', 'properties', 'origin', 'ingested_by', 'agent', 'ingestion_method', 'session_id', 'model', 'harness', 'created_at', 'updated_at', 'rev'],
  entries: ['id', 'engram_id', 'kind', 'at', 'author', 'agent', 'session_id', 'model', 'stage', 'text', 'source', 'stance', 'quote', 'rule_id'],
  relations: ['id', 'source_id', 'target_id', 'relation', 'detection_method', 'strength', 'explanation', 'metadata', 'created_at'],
  engram_tags: ['engram_id', 'tag_id', 'created_at'],
  engram_subjects: ['engram_id', 'subject_id', 'created_at'],
} as const

export type MovedTable = keyof typeof MOVED_COLUMNS
export type MovedRow = Record<string, string | number | null>
export type MovedRows = Record<MovedTable, MovedRow[]>

/** The set's own tables: what moves out of the source, and what set_hash covers. */
export const SET_TABLES = ['engrams', 'entries', 'relations', 'engram_tags', 'engram_subjects'] as const

/** A relation with one end in the set and one outside: it does not move. */
export interface CrossingRelation { id: string, source_id: string, target_id: string, relation: string }
/** An entry naming an engram by id (a learning's rule_id) across the set's edge: it stays as it is. */
export interface ExternalRef { entry_id: string, engram_id: string, rule_id: string }

export interface ExportedSet {
  rows: MovedRows
  /** sha256 of the set's own rows as canonical JSON: what the import carries and the move_out checks. */
  set_hash: string
  crossing: CrossingRelation[]
  /** Entries of the set naming an engram outside it: they move, the id stays as text. */
  external_refs: ExternalRef[]
  /** Entries outside the set naming an engram in it: they stay, the id stays as text. */
  incoming_refs: ExternalRef[]
}

/** The hash of a set's own rows (SET_TABLES); the registry rows are not part of it. */
export function setHash(rows: MovedRows): string {
  return sha256Hex(canonicalJson(Object.fromEntries(SET_TABLES.map(t => [t, rows[t]]))))
}

/** A move names at least one engram, each once. */
export function checkIds(ids: readonly string[]): void {
  if (ids.length === 0) throw new CommandError('INVALID', 'Invalid command: a move takes at least one engram id.')
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (twice.length > 0) throw new CommandError('INVALID', `Invalid command: a move names each engram once (${[...new Set(twice)].join(', ')} twice).`)
}

/**
 * The rows of engrams `ids` and of everything that moves with them, each table
 * in a fixed order (engrams, entries and relations by ord, projects parents
 * first, the rest by primary key), plus what does not move: the crossing
 * relations and the references across the set's edge. An unknown id, or a
 * scope object missing in this brain, is NOT_FOUND.
 */
export function exportSet(db: Database.Database, ids: readonly string[]): ExportedSet {
  checkIds(ids)
  const inSet = new Set(ids)
  const json = JSON.stringify(ids)
  const S = 'SELECT value FROM json_each(?)'
  const cols = (table: MovedTable) => MOVED_COLUMNS[table].map(c => `"${c}"`).join(', ')
  const all = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as MovedRow[]

  const engrams = all(`SELECT ${cols('engrams')} FROM engrams WHERE id IN (${S}) ORDER BY ord`, json)
  const unknown = ids.filter(id => !engrams.some(e => e.id === id))
  if (unknown.length > 0) throw new CommandError('NOT_FOUND', `engram${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} not found`)

  const rows: MovedRows = {
    projects: projectsWithParents(db, engrams),
    entities: [], users: [], agents: [],
    tags: all(`SELECT ${cols('tags')} FROM tags WHERE id IN (SELECT tag_id FROM engram_tags WHERE engram_id IN (${S})) ORDER BY id`, json),
    subjects: all(`SELECT ${cols('subjects')} FROM subjects WHERE id IN (SELECT subject_id FROM engram_subjects WHERE engram_id IN (${S})) ORDER BY id`, json),
    engrams,
    entries: all(`SELECT ${cols('entries')} FROM entries WHERE engram_id IN (${S}) ORDER BY ord`, json),
    relations: all(`SELECT ${cols('relations')} FROM relations WHERE source_id IN (${S}) AND target_id IN (${S}) ORDER BY ord`, json, json),
    engram_tags: all(`SELECT ${cols('engram_tags')} FROM engram_tags WHERE engram_id IN (${S}) ORDER BY engram_id, tag_id`, json),
    engram_subjects: all(`SELECT ${cols('engram_subjects')} FROM engram_subjects WHERE engram_id IN (${S}) ORDER BY engram_id, subject_id`, json),
  }
  for (const table of ['entities', 'users', 'agents'] as const) {
    const objectIds = scopedIds(engrams, table)
    rows[table] = all(`SELECT ${cols(table)} FROM ${table} WHERE id IN (${S}) ORDER BY id`, JSON.stringify(objectIds))
    const missing = objectIds.filter(id => !rows[table].some(r => r.id === id))
    if (missing.length > 0) throw new CommandError('NOT_FOUND', `${table} ${missing.join(', ')} not found in the source brain (the scope of an engram in the set)`)
  }

  const crossing = db.prepare(`SELECT id, source_id, target_id, relation FROM relations WHERE (source_id IN (${S})) <> (target_id IN (${S})) ORDER BY ord`)
    .all(json, json) as CrossingRelation[]
  const external_refs = rows.entries
    .filter(e => e.rule_id !== null && !inSet.has(e.rule_id as string))
    .map(e => ({ entry_id: e.id as string, engram_id: e.engram_id as string, rule_id: e.rule_id as string }))
  const incoming_refs = db.prepare(`SELECT id AS entry_id, engram_id, rule_id FROM entries WHERE rule_id IN (${S}) AND engram_id NOT IN (${S}) ORDER BY ord`)
    .all(json, json) as ExternalRef[]
  return { rows, set_hash: setHash(rows), crossing, external_refs, incoming_refs }
}

/** Whether `named` are exactly the set's crossing relations: the drop_relations a move has to pass. */
export function namesCrossing(set: ExportedSet, named: readonly string[]): boolean {
  const crossing = set.crossing.map(r => r.id).sort()
  const sorted = [...named].sort()
  return crossing.length === sorted.length && crossing.every((id, i) => id === sorted[i])
}

/** The ids of `table`'s objects that the engrams' scopes name. */
function scopedIds(engrams: MovedRow[], table: 'projects' | 'entities' | 'users' | 'agents'): string[] {
  return [...new Set(engrams.map(e => scopeObject(e.scope as string)).filter(o => o?.[0] === table).map(o => o![1]))].sort()
}

/** The projects the set's scopes name, each after its parent_project chain (the foreign key needs the parent first). */
function projectsWithParents(db: Database.Database, engrams: MovedRow[]): MovedRow[] {
  const get = db.prepare(`SELECT ${MOVED_COLUMNS.projects.map(c => `"${c}"`).join(', ')} FROM projects WHERE id = ?`)
  const out: MovedRow[] = []
  const seen = new Set<string>()
  for (const id of scopedIds(engrams, 'projects')) {
    const chain: MovedRow[] = []
    for (let p: string | null = id; p !== null && !seen.has(p); ) {
      const row = get.get(p) as MovedRow | undefined
      if (!row) throw new CommandError('NOT_FOUND', `project ${p} not found in the source brain (${p === id ? 'the scope of an engram in the set' : 'a parent of a project the set needs'})`)
      seen.add(p)
      chain.unshift(row)
      p = row.parent_project as string | null
    }
    out.push(...chain)
  }
  return out
}

/** A brain as the other side of a move names it: its genesis op_id and its head seq. */
export function brainRef(db: Database.Database): { brain: string, head_seq: number } {
  const genesis = db.prepare('SELECT payload FROM op_log WHERE seq = 1').get() as { payload: string } | undefined
  if (!genesis) throw new Error('the brain has no op log')
  const head = db.prepare('SELECT MAX(seq) AS seq FROM op_log').get() as { seq: number }
  return { brain: (JSON.parse(genesis.payload) as OpEnvelope).op_id, head_seq: head.seq }
}
