import Database from 'better-sqlite3'
import { currentSchemaSql } from '../database'
import type { Entry } from '../entries'
import { insertEntryRow } from '../entries'
import { scopeObject, validateScopePattern } from '../validate'
import { insertEngramRow, insertRelationRow, type EngramRow, type RelationRow } from '../write/insert'
import type { WriteContext } from '../write/context'
import {
  insertProjectRow, insertEntityRow, insertUserRow, insertAgentRow, insertTagRow, insertSubjectRow,
  type ProjectRow, type EntityRow, type UserRow, type AgentRow, type TagRow, type SubjectRow,
} from '../write/objects'
import { activeCoreProfileIn, activeStatusIn } from '../write/supersede'
import { insertEngramTagRow, insertEngramSubjectRow } from '../write/tags-subjects'
import { MOVED_COLUMNS, setHash, type MovedRow, type MovedRows, type MovedTable } from '../log/move'
import { CommandError, inputObject, type CommandModule } from './types'

/** What an import carries: the rows of the set (log/move.ts exportSet), their hash and the brain they come from. */
export interface EngramImportInput {
  source: { brain: string, head_seq: number }
  set_hash: string
  rows: MovedRows
}

export interface EngramImportResult {
  moved: { engrams: number, entries: number, relations: number }
  /** The registry rows the import created; the ones the target had already stay as they are. */
  created: Record<ObjectTable, string[]>
}

const OBJECT_TABLES = ['projects', 'entities', 'users', 'agents', 'tags', 'subjects'] as const
type ObjectTable = typeof OBJECT_TABLES[number]
const IMPORT_KEYS = ['source', 'set_hash', 'rows']

/** What the import's checks read in the target: the connection and the registries' stores. */
export type ImportStores = Pick<WriteContext, 'db' | ObjectTable>

/**
 * engram.import — engrams from another brain with their history, as they are
 * there: ids, authorship, times, rev, journals, the relations inside the set,
 * tags and subjects. Missing scope objects, tags and subjects are created from
 * the carried rows. Any collision refuses the whole import. It is the gate for
 * rows from elsewhere, so it checks every column before a row goes in. Not
 * reachable by agents: no route calls it (spec cross-brain-move-spec).
 */
export const engramImport: CommandModule<EngramImportInput, EngramImportResult> = {
  name: 'engram.import',
  validate(input) {
    const o = inputObject('engram.import', input)
    const extra = Object.keys(o).filter(k => !IMPORT_KEYS.includes(k))
    if (extra.length > 0) invalid(`unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')} — it takes ${IMPORT_KEYS.join(', ')}`)
    const source = o.source as Record<string, unknown> | undefined
    if (!source || typeof source.brain !== 'string' || !Number.isSafeInteger(source.head_seq) || (source.head_seq as number) < 1) {
      invalid('source is { brain: the source\'s genesis op_id, head_seq: its head seq }')
    }
    const rows = checkImportRows(o.rows)
    if (o.set_hash !== setHash(rows)) invalid('set_hash does not match the rows')
    return { source: { brain: source!.brain as string, head_seq: source!.head_seq as number }, set_hash: o.set_hash as string, rows }
  },
  apply(ctx, input) {
    const { rows } = input
    const problems = importProblems(ctx, rows)
    if (problems.length > 0) throw new CommandError('CONFLICT', `engram.import refused: ${problems.join('; ')}.`)

    const created = missingObjects(ctx, rows)
    for (const table of OBJECT_TABLES) {
      rows[table].forEach((row, i) => {
        if (created[table].includes(row.id as string)) insert(table, i, row, () => INSERT_OBJECT[table](ctx.db, row))
      })
    }
    rows.engrams.forEach((row, i) => insert('engrams', i, row, () => insertEngramRow(ctx.db, row as unknown as EngramRow)))
    rows.entries.forEach((row, i) => insert('entries', i, row, () => insertEntryRow(ctx.db, row as unknown as Entry)))
    rows.relations.forEach((row, i) => insert('relations', i, row, () => {
      if (!insertRelationRow(ctx.db, row as unknown as RelationRow)) {
        throw new CommandError('CONFLICT', `engram.import refused: relation ${row.id} (${row.source_id} ${row.relation} ${row.target_id}) is already in this brain under another id.`)
      }
    }))
    rows.engram_tags.forEach((row, i) => insert('engram_tags', i, row, () => insertEngramTagRow(ctx.db, row as { engram_id: string, tag_id: string, created_at: string })))
    rows.engram_subjects.forEach((row, i) => insert('engram_subjects', i, row, () => insertEngramSubjectRow(ctx.db, row as { engram_id: string, subject_id: string, created_at: string })))
    return { moved: { engrams: rows.engrams.length, entries: rows.entries.length, relations: rows.relations.length }, created }
  },
}

const INSERT_OBJECT: Record<ObjectTable, (db: Database.Database, row: MovedRow) => void> = {
  projects: (db, row) => insertProjectRow(db, row as unknown as ProjectRow),
  entities: (db, row) => insertEntityRow(db, row as unknown as EntityRow),
  users: (db, row) => insertUserRow(db, row as unknown as UserRow),
  agents: (db, row) => insertAgentRow(db, row as unknown as AgentRow),
  tags: (db, row) => insertTagRow(db, row as unknown as TagRow),
  subjects: (db, row) => insertSubjectRow(db, row as unknown as SubjectRow),
}

/** One row in; a value the schema refuses (a type, status or verb outside its set …) is INVALID naming the row. */
function insert(table: MovedTable, i: number, row: MovedRow, write: () => void): void {
  try {
    write()
  } catch (err) {
    if (String((err as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')) invalid(`${rowName(table, i, row)}: ${(err as Error).message}`)
    throw err
  }
}

function invalid(message: string): never {
  throw new CommandError('INVALID', `Invalid command: engram.import: ${message}.`)
}

function rowName(table: MovedTable, i: number, row: MovedRow): string {
  return `rows.${table}[${i}]${typeof row.id === 'string' ? ` (${row.id})` : ''}`
}

/** The rows of an import as its validate checks them (shape, columns, links); planMove runs the same. */
export function checkImportRows(value: unknown): MovedRows {
  const rows = checkRows(value)
  checkLinks(rows)
  return rows
}

const JSON_COLUMNS = new Set(['properties', 'metadata', 'domains'])
const TIME_COLUMNS = new Set(['created_at', 'updated_at', 'at'])
const DATE_COLUMNS = new Set(['started_at', 'ended_at'])
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/

/** Each carried column's declared type and NOT NULL, from the current schema (read once). */
let schemaColumns: Map<string, { type: string, notnull: boolean }> | undefined
function columnOf(table: MovedTable, column: string): { type: string, notnull: boolean } {
  if (!schemaColumns) {
    const db = new Database(':memory:')
    try {
      db.exec(currentSchemaSql())
      schemaColumns = new Map()
      for (const t of Object.keys(MOVED_COLUMNS)) {
        for (const c of db.prepare('SELECT name, type, "notnull" AS required FROM pragma_table_info(?)').all(t) as Array<{ name: string, type: string, required: number }>) {
          schemaColumns.set(`${t}.${c.name}`, { type: c.type, notnull: c.required === 1 })
        }
      }
    } finally {
      db.close()
    }
  }
  return schemaColumns.get(`${table}.${column}`)!
}

/** Whether `v` is a value of the schema's column: its type (TEXT, INTEGER, REAL) or, where allowed, null. */
function fitsColumn(v: unknown, column: { type: string, notnull: boolean }): boolean {
  if (v === null) return !column.notnull
  if (column.type === 'TEXT') return typeof v === 'string'
  if (column.type === 'INTEGER') return Number.isSafeInteger(v)
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * rows: every table, each an array of rows with exactly the carried columns;
 * each value of its column's type in the schema (null only where the schema
 * allows it); ids unique per table; JSON columns parse; times ISO-8601 UTC ms,
 * project dates ISO-8601; rev ≥ 1; scopes well-formed.
 */
function checkRows(value: unknown): MovedRows {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('rows is an object of tables')
  const rows = value as Record<string, unknown>
  const tables = Object.keys(MOVED_COLUMNS) as MovedTable[]
  const extra = Object.keys(rows).filter(t => !(tables as string[]).includes(t))
  if (extra.length > 0) invalid(`rows has unknown table${extra.length > 1 ? 's' : ''} ${extra.join(', ')}`)
  for (const table of tables) {
    const list = rows[table]
    if (!Array.isArray(list)) invalid(`rows.${table} is an array`)
    const columns = MOVED_COLUMNS[table] as readonly string[]
    const keys = new Set<string>()
    for (const [i, row] of list.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid(`rows.${table}[${i}] is a row`)
      const r = row as MovedRow
      const name = rowName(table, i, r)
      const cols = Object.keys(r)
      if (cols.length !== columns.length || !columns.every(c => cols.includes(c))) invalid(`${name} has the columns ${columns.join(', ')}`)
      for (const c of columns) {
        const v = r[c]
        const column = columnOf(table, c)
        if (!fitsColumn(v, column)) invalid(`${name}.${c} is ${column.type === 'TEXT' ? 'text' : column.type === 'INTEGER' ? 'an integer' : 'a number'}${column.notnull ? '' : ' or null'}`)
        if (JSON_COLUMNS.has(c) && v !== null && !parses(v as string)) invalid(`${name}.${c} is JSON text or null`)
        if (TIME_COLUMNS.has(c) && !ISO_MS.test(v as string)) invalid(`${name}.${c} is an ISO-8601 UTC time with milliseconds`)
        if (DATE_COLUMNS.has(c) && v !== null && !ISO_DATE.test(v as string)) invalid(`${name}.${c} is an ISO-8601 date or time, or null`)
      }
      // ids are TEXT NOT NULL (checked above); a link row's key is its pair
      const key = table === 'engram_tags' ? `${r.engram_id} ${r.tag_id}` : table === 'engram_subjects' ? `${r.engram_id} ${r.subject_id}` : r.id as string
      if (key === '') invalid(`${name}.id is not empty`)
      if (keys.has(key)) invalid(`${name} appears twice in rows.${table}`)
      keys.add(key)
      if (table === 'engrams') {
        if ((r.rev as number) < 1) invalid(`${name}.rev is an integer ≥ 1`)
        try { validateScopePattern(r.scope as string) } catch (err) { invalid(`${name}: ${(err as Error).message}`) }
      }
    }
  }
  if ((rows.engrams as unknown[]).length === 0) invalid('the set has no engrams')
  return rows as MovedRows
}

function parses(v: string): boolean {
  try { JSON.parse(v); return true } catch { return false }
}

/**
 * Everything the set's rows point at is in the set or carried with it, and
 * every carried registry row is needed: a scope object by a scope (a project
 * also as a parent of one), a tag or subject by a link. A relation appears
 * once per (source, target, relation).
 */
function checkLinks(rows: MovedRows): void {
  const ids = (table: MovedTable) => new Set(rows[table].map(r => r.id as string))
  const engrams = ids('engrams')
  const outside = (what: string, id: unknown, set: Set<string>) => {
    if (!set.has(id as string)) invalid(`${what} ${String(id)} is not in the set`)
  }
  for (const e of rows.entries) outside(`entry ${e.id} belongs to engram`, e.engram_id, engrams)
  const triples = new Set<string>()
  for (const r of rows.relations) {
    outside(`relation ${r.id} starts at engram`, r.source_id, engrams)
    outside(`relation ${r.id} ends at engram`, r.target_id, engrams)
    const triple = `${r.source_id} ${r.relation} ${r.target_id}`
    if (triples.has(triple)) invalid(`relation ${r.id} repeats ${triple}`)
    triples.add(triple)
  }
  const tags = ids('tags')
  for (const t of rows.engram_tags) { outside('a tag link names engram', t.engram_id, engrams); outside('a tag link names tag', t.tag_id, tags) }
  const subjects = ids('subjects')
  for (const s of rows.engram_subjects) { outside('a subject link names engram', s.engram_id, engrams); outside('a subject link names subject', s.subject_id, subjects) }

  const needed: Record<ObjectTable, Set<string>> = {
    projects: new Set(), entities: new Set(), users: new Set(), agents: new Set(),
    tags: new Set(rows.engram_tags.map(t => t.tag_id as string)),
    subjects: new Set(rows.engram_subjects.map(s => s.subject_id as string)),
  }
  for (const e of rows.engrams) {
    const object = scopeObject(e.scope as string)
    if (!object) continue
    if (!rows[object[0]].some(r => r.id === object[1])) invalid(`the scope object of ${e.scope} is not carried`)
    needed[object[0]].add(object[1])
  }
  // a carried parent comes before its child, and is needed through it
  const seen = new Set<string>()
  const carried = ids('projects')
  for (const p of [...rows.projects].reverse()) {
    if (needed.projects.has(p.id as string) && p.parent_project !== null) needed.projects.add(p.parent_project as string)
  }
  for (const p of rows.projects) {
    if (p.parent_project !== null && carried.has(p.parent_project as string) && !seen.has(p.parent_project as string)) {
      invalid(`project ${p.id} comes before its parent ${p.parent_project}`)
    }
    seen.add(p.id as string)
  }
  for (const table of OBJECT_TABLES) {
    const unneeded = rows[table].filter(r => !needed[table].has(r.id as string)).map(r => r.id)
    if (unneeded.length > 0) invalid(`rows.${table} carries ${unneeded.join(', ')}, which no engram of the set needs`)
  }
}

/**
 * The carried registry rows this brain does not have yet and the set needs:
 * what an import creates. A carried parent project only when a project being
 * created needs it.
 */
export function missingObjects(stores: ImportStores, rows: MovedRows): EngramImportResult['created'] {
  const missing = (table: ObjectTable) => rows[table].map(r => r.id as string).filter(id => !stores[table].exists(id))
  const parentOf = new Map(rows.projects.map(p => [p.id as string, p.parent_project as string | null]))
  const projects = new Set<string>()
  for (const e of rows.engrams) {
    const object = scopeObject(e.scope as string)
    for (let p = object?.[0] === 'projects' ? object[1] : null; p !== null && parentOf.has(p) && !projects.has(p) && !stores.projects.exists(p); p = parentOf.get(p)!) {
      projects.add(p)
    }
  }
  return {
    projects: rows.projects.map(p => p.id as string).filter(id => projects.has(id)),
    entities: missing('entities'), users: missing('users'), agents: missing('agents'),
    tags: missing('tags'), subjects: missing('subjects'),
  }
}

/**
 * Why this brain refuses the rows, all of it (none: the import goes in): an id
 * of the set it has already, an active core profile or active status in the
 * scope of a carried one, a project to create whose parent is neither created
 * with it nor here.
 */
export function importProblems(stores: ImportStores, rows: MovedRows): string[] {
  const { db } = stores
  const problems: string[] = []
  for (const table of ['engrams', 'entries', 'relations'] as const) {
    const taken = (db.prepare(`SELECT id FROM ${table} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`)
      .all(JSON.stringify(rows[table].map(r => r.id))) as Array<{ id: string }>).map(r => r.id)
    if (taken.length > 0) problems.push(`${table} ${taken.join(', ')} already in this brain`)
  }
  for (const e of rows.engrams) {
    if (e.status !== 'active') continue
    const scope = e.scope as string
    const core = e.type === 'profile' && (JSON.parse((e.properties as string | null) ?? '{}') as { core?: unknown }).core === true
    const clash = core ? activeCoreProfileIn(db, scope, e.id as string)
      : e.type === 'status' ? activeStatusIn(db, scope, e.id as string)?.id
        : undefined
    if (clash) problems.push(`${scope} has an active ${core ? 'core profile' : 'status'} (${clash}) next to the carried ${e.id}`)
  }
  const created = new Set(missingObjects(stores, rows).projects)
  for (const p of rows.projects) {
    if (!created.has(p.id as string) || p.parent_project === null) continue
    if (!created.has(p.parent_project as string) && !stores.projects.exists(p.parent_project as string)) {
      problems.push(`project ${p.id} needs its parent ${p.parent_project}, which is neither carried nor in this brain`)
    }
  }
  return problems
}
