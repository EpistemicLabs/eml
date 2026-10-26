import type Database from 'better-sqlite3'
import { CommandError } from '../commands/types'
import { canonicalJson } from './canonical'
import { sha256Hex, type OpEnvelope } from './op'

// --- Moving engrams between brains (v0.21) ---------------------------------------
//
// A set of engrams leaves one brain and arrives in another with its history
// (spec cross-brain-move-spec; decision team-brain-move-project-as-import):
// engram.import writes the rows as they are into the target, engram.move_out
// removes them from the source. Both are ops in their brain's log. The set is
// exported here as rows: the engrams, their entries, the relations inside the
// set, their tag and subject links, and the registry rows they need — scope
// objects (a project with its parents), tags and subjects. ord is not carried;
// the target appends the rows in their source order.

/** The columns carried per table, in insert order of the tables: every stored column but ord. */
export const MOVED_COLUMNS = {
  projects: ['id', 'name', 'status', 'goal', 'description', 'owner', 'parent_project', 'started_at', 'ended_at', 'metadata', 'status_tracks', 'created_at', 'updated_at'],
  entities: ['id', 'name', 'kind', 'status', 'description', 'metadata', 'status_tracks', 'created_at', 'updated_at'],
  users: ['id', 'name', 'email', 'description', 'metadata', 'created_at', 'updated_at'],
  agents: ['id', 'name', 'parent_id', 'domains', 'description', 'metadata', 'created_at'],
  tags: ['id', 'name', 'description', 'status', 'created_at'],
  subjects: ['id', 'name', 'description', 'status', 'created_at', 'updated_at'],
  engrams: ['id', 'type', 'scope', 'title', 'content', 'status', 'significance', 'properties', 'origin', 'ingested_by', 'ingestion_method', 'session_id', 'model', 'harness', 'created_at', 'updated_at', 'rev'],
  entries: ['id', 'engram_id', 'kind', 'at', 'author', 'session_id', 'model', 'stage', 'text', 'source', 'stance', 'quote', 'rule_id'],
  relations: ['id', 'source_id', 'target_id', 'relation', 'detection_method', 'strength', 'explanation', 'metadata', 'created_at'],
  engram_tags: ['engram_id', 'tag_id', 'created_at'],
  engram_subjects: ['engram_id', 'subject_id', 'created_at'],
} as const

export type MovedTable = keyof typeof MOVED_COLUMNS
export type MovedRow = Record<string, string | number | null>
export type MovedRows = Record<MovedTable, MovedRow[]>

/** The scope kinds with an object, and their table. */
export const SCOPE_TABLES: Record<string, 'projects' | 'entities' | 'users' | 'agents'> = {
  project: 'projects', entity: 'entities', user: 'users', agent: 'agents',
}

/** A relation with one end in the set and one outside: it does not move. */
export interface CrossingRelation { id: string, source_id: string, target_id: string, relation: string }
/** An entry of the set naming an engram outside it (a learning's rule_id): moves, and its id stays as text. */
export interface ExternalRef { entry_id: string, engram_id: string, rule_id: string }

export interface ExportedSet {
  rows: MovedRows
  /** sha256 of the rows as canonical JSON: what the import carries and the move_out checks. */
  set_hash: string
  crossing: CrossingRelation[]
  external_refs: ExternalRef[]
}

/** The hash of a set's rows. */
export function setHash(rows: MovedRows): string {
  return sha256Hex(canonicalJson(rows))
}

/** The scope's object as [table, id], or undefined for global. */
export function scopeObject(scope: string): [table: 'projects' | 'entities' | 'users' | 'agents', id: string] | undefined {
  const dot = scope.indexOf('.')
  if (dot < 0) return undefined
  const table = SCOPE_TABLES[scope.slice(0, dot)]
  return table ? [table, scope.slice(dot + 1)] : undefined
}

/**
 * The rows of engrams `ids` and of everything that moves with them, each table
 * in a fixed order (engrams, entries and relations by ord, projects parents
 * first, the rest by primary key), plus what does not move: the crossing
 * relations and the external references. An unknown id is NOT_FOUND.
 */
export function exportSet(db: Database.Database, ids: readonly string[]): ExportedSet {
  const set = [...new Set(ids)]
  if (set.length === 0) throw new CommandError('INVALID', 'Invalid command: a move takes at least one engram id.')
  const inSet = new Set(set)
  const json = JSON.stringify(set)
  const S = 'SELECT value FROM json_each(?)'
  const cols = (table: MovedTable) => MOVED_COLUMNS[table].map(c => `"${c}"`).join(', ')
  const all = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as MovedRow[]

  const engrams = all(`SELECT ${cols('engrams')} FROM engrams WHERE id IN (${S}) ORDER BY ord`, json)
  const unknown = set.filter(id => !engrams.some(e => e.id === id))
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
    const objectIds = [...new Set(engrams.map(e => scopeObject(e.scope as string)).filter(o => o?.[0] === table).map(o => o![1]))]
    rows[table] = all(`SELECT ${cols(table)} FROM ${table} WHERE id IN (${S}) ORDER BY id`, JSON.stringify(objectIds))
    const missing = objectIds.filter(id => !rows[table].some(r => r.id === id))
    if (missing.length > 0) throw new Error(`${table} ${missing.join(', ')} not found in the source brain`)
  }

  const crossing = db.prepare(`SELECT id, source_id, target_id, relation FROM relations WHERE (source_id IN (${S})) <> (target_id IN (${S})) ORDER BY ord`)
    .all(json, json) as CrossingRelation[]
  const external_refs = rows.entries
    .filter(e => e.rule_id !== null && !inSet.has(e.rule_id as string))
    .map(e => ({ entry_id: e.id as string, engram_id: e.engram_id as string, rule_id: e.rule_id as string }))
  return { rows, set_hash: setHash(rows), crossing, external_refs }
}

/** The projects the set's scopes name, each after its parent_project chain (the foreign key needs the parent first). */
function projectsWithParents(db: Database.Database, engrams: MovedRow[]): MovedRow[] {
  const get = db.prepare(`SELECT ${MOVED_COLUMNS.projects.map(c => `"${c}"`).join(', ')} FROM projects WHERE id = ?`)
  const scoped = [...new Set(engrams.map(e => scopeObject(e.scope as string)).filter(o => o?.[0] === 'projects').map(o => o![1]))].sort()
  const out: MovedRow[] = []
  const seen = new Set<string>()
  for (const id of scoped) {
    const chain: MovedRow[] = []
    for (let p: string | null = id; p !== null && !seen.has(p); ) {
      const row = get.get(p) as MovedRow | undefined
      if (!row) throw new Error(`projects ${p} not found in the source brain`)
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
