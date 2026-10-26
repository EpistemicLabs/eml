import type Database from 'better-sqlite3'
import type { Entry } from '../entries'
import { insertEntryRow } from '../entries'
import { insertEngramRow, insertRelationRow, type EngramRow, type RelationRow } from '../write/insert'
import {
  insertProjectRow, insertEntityRow, insertUserRow, insertAgentRow, insertTagRow, insertSubjectRow,
  type ProjectRow, type EntityRow, type UserRow, type AgentRow, type TagRow, type SubjectRow,
} from '../write/objects'
import { insertEngramTagRow, insertEngramSubjectRow } from '../write/tags-subjects'
import { MOVED_COLUMNS, scopeObject, setHash, type MovedRow, type MovedRows, type MovedTable } from '../log/move'
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
  created: Record<'projects' | 'entities' | 'users' | 'agents' | 'tags' | 'subjects', string[]>
}

const OBJECT_TABLES = ['projects', 'entities', 'users', 'agents', 'tags', 'subjects'] as const
const IMPORT_KEYS = ['source', 'set_hash', 'rows']

/**
 * engram.import — engrams from another brain with their history, as they are
 * there: ids, authorship, times, rev, journals, the relations inside the set,
 * tags and subjects. Missing scope objects, tags and subjects are created from
 * the carried rows. Any collision refuses the whole import. Not reachable by
 * agents: no route calls it (spec cross-brain-move-spec).
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
    const rows = checkRows(o.rows)
    if (o.set_hash !== setHash(rows)) invalid('set_hash does not match the rows')
    checkLinks(rows)
    return { source: { brain: source!.brain as string, head_seq: source!.head_seq as number }, set_hash: o.set_hash as string, rows }
  },
  apply(ctx, input) {
    const { db } = ctx
    const { rows } = input
    const problems = importProblems(db, rows)
    if (problems.length > 0) throw new CommandError('CONFLICT', `engram.import refused: ${problems.join('; ')}.`)

    const created = missingObjects(db, rows)
    for (const table of OBJECT_TABLES) {
      for (const row of rows[table]) {
        if (created[table].includes(row.id as string)) INSERT_OBJECT[table](db, row)
      }
    }
    for (const row of rows.engrams) insertEngramRow(db, row as unknown as EngramRow)
    for (const row of rows.entries) insertEntryRow(db, row as unknown as Entry)
    for (const row of rows.relations) insertRelationRow(db, row as unknown as RelationRow)
    for (const row of rows.engram_tags) insertEngramTagRow(db, row as { engram_id: string, tag_id: string, created_at: string })
    for (const row of rows.engram_subjects) insertEngramSubjectRow(db, row as { engram_id: string, subject_id: string, created_at: string })
    return { moved: { engrams: rows.engrams.length, entries: rows.entries.length, relations: rows.relations.length }, created }
  },
}

const INSERT_OBJECT: Record<typeof OBJECT_TABLES[number], (db: Database.Database, row: MovedRow) => void> = {
  projects: (db, row) => insertProjectRow(db, row as unknown as ProjectRow),
  entities: (db, row) => insertEntityRow(db, row as unknown as EntityRow),
  users: (db, row) => insertUserRow(db, row as unknown as UserRow),
  agents: (db, row) => insertAgentRow(db, row as unknown as AgentRow),
  tags: (db, row) => insertTagRow(db, row as unknown as TagRow),
  subjects: (db, row) => insertSubjectRow(db, row as unknown as SubjectRow),
}

function invalid(message: string): never {
  throw new CommandError('INVALID', `Invalid command: engram.import: ${message}.`)
}

/** rows: every table, each an array of rows with exactly the carried columns, values text, number or null. */
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
    for (const [i, row] of list.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid(`rows.${table}[${i}] is a row`)
      const keys = Object.keys(row)
      if (keys.length !== columns.length || !columns.every(c => keys.includes(c))) {
        invalid(`rows.${table}[${i}] has the columns ${columns.join(', ')}`)
      }
      for (const c of columns) {
        const v = (row as Record<string, unknown>)[c]
        if (v !== null && typeof v !== 'string' && typeof v !== 'number') invalid(`rows.${table}[${i}].${c} is text, a number or null`)
      }
    }
  }
  if ((rows.engrams as unknown[]).length === 0) invalid('the set has no engrams')
  return rows as MovedRows
}

/** Everything the set's rows point at is in the set or carried with it. */
function checkLinks(rows: MovedRows): void {
  const ids = (table: MovedTable) => new Set(rows[table].map(r => r.id as string))
  const engrams = ids('engrams')
  if (engrams.size !== rows.engrams.length) invalid('an engram id appears twice')
  const outside = (what: string, id: unknown, set: Set<string>) => {
    if (!set.has(id as string)) invalid(`${what} ${String(id)} is not in the set`)
  }
  for (const e of rows.entries) outside(`entry ${e.id} belongs to engram`, e.engram_id, engrams)
  for (const r of rows.relations) {
    outside(`relation ${r.id} starts at engram`, r.source_id, engrams)
    outside(`relation ${r.id} ends at engram`, r.target_id, engrams)
  }
  const tags = ids('tags')
  for (const t of rows.engram_tags) { outside('a tag link names engram', t.engram_id, engrams); outside('a tag link names tag', t.tag_id, tags) }
  const subjects = ids('subjects')
  for (const s of rows.engram_subjects) { outside('a subject link names engram', s.engram_id, engrams); outside('a subject link names subject', s.subject_id, subjects) }
  for (const e of rows.engrams) {
    const object = scopeObject(e.scope as string)
    if (object && !rows[object[0]].some(r => r.id === object[1])) invalid(`the scope object of ${e.scope} is not carried`)
  }
  // a carried parent comes before its child
  const seen = new Set<string>()
  const carried = ids('projects')
  for (const p of rows.projects) {
    if (p.parent_project !== null && carried.has(p.parent_project as string) && !seen.has(p.parent_project as string)) {
      invalid(`project ${p.id} comes before its parent ${p.parent_project}`)
    }
    seen.add(p.id as string)
  }
}

function exists(db: Database.Database, table: MovedTable, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)
}

/** The carried scope objects, tags and subjects this brain does not have yet: what an import creates. */
export function missingObjects(db: Database.Database, rows: MovedRows): EngramImportResult['created'] {
  const missing = (table: typeof OBJECT_TABLES[number]) => rows[table].map(r => r.id as string).filter(id => !exists(db, table, id))
  return {
    projects: missing('projects'), entities: missing('entities'), users: missing('users'),
    agents: missing('agents'), tags: missing('tags'), subjects: missing('subjects'),
  }
}

/**
 * Why this brain refuses the rows, all of it (none: the import goes in): an id
 * of the set it has already, an active core profile or active status in the
 * scope of a carried one, a project whose parent is neither carried nor here.
 */
export function importProblems(db: Database.Database, rows: MovedRows): string[] {
  const problems: string[] = []
  for (const table of ['engrams', 'entries', 'relations'] as const) {
    const taken = (db.prepare(`SELECT id FROM ${table} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`)
      .all(JSON.stringify(rows[table].map(r => r.id))) as Array<{ id: string }>).map(r => r.id)
    if (taken.length > 0) problems.push(`${table} ${taken.join(', ')} already in this brain`)
  }
  for (const e of rows.engrams) {
    if (e.status !== 'active') continue
    const core = e.type === 'profile' && (JSON.parse((e.properties as string | null) ?? '{}') as { core?: unknown }).core === true
    const clash = core
      ? db.prepare(`SELECT id FROM engrams WHERE scope = ? AND type = 'profile' AND status = 'active' AND json_extract(properties, '$.core') = 1`).get(e.scope)
      : e.type === 'status'
        ? db.prepare(`SELECT id FROM engrams WHERE scope = ? AND type = 'status' AND status = 'active'`).get(e.scope)
        : undefined
    if (clash) problems.push(`${e.scope} has an active ${core ? 'core profile' : 'status'} (${(clash as { id: string }).id}) next to the carried ${e.id}`)
  }
  const carried = new Set(rows.projects.map(p => p.id as string))
  for (const p of rows.projects) {
    if (p.parent_project === null || exists(db, 'projects', p.id as string)) continue
    if (!carried.has(p.parent_project as string) && !exists(db, 'projects', p.parent_project as string)) {
      problems.push(`project ${p.id} needs its parent ${p.parent_project}, which is neither carried nor in this brain`)
    }
  }
  return problems
}
