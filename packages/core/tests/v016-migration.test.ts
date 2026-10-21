import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { initControlDatabase } from '../src/control'
import { runForwardMigrations } from '../src/forward-migrations'

// v0.16 — v0.16_migrate.sql removes the epistemic mode: epistemic engrams become
// notes (former type in properties.original_epistemic_type), `evaluates` edges
// become `related_to`, and engrams + relations are rebuilt without `mode`, the
// five epistemic types and `evaluates`. These tests take a seeded v0.15 brain to
// 16 through both runners and check that nothing is lost.

const MIGRATIONS = join(__dirname, '..', 'migrations', 'brain')
const V12_FIXTURE = join(__dirname, 'fixtures', 'brain-v12.sql')
const EPISTEMIC = ['observation', 'hypothesis', 'assessment', 'prediction', 'pattern']

/** A brain exactly as v0.15 left it: epistemic + context engrams, edges, facets, a task entry. */
function createV15Brain(file: string): void {
  const db = new Database(file)
  db.exec(readFileSync(V12_FIXTURE, 'utf-8'))
  db.exec(readFileSync(join(MIGRATIONS, 'v0.13_migrate.sql'), 'utf-8'))
  db.pragma('foreign_keys = OFF')
  db.exec(readFileSync(join(MIGRATIONS, 'v0.14_migrate.sql'), 'utf-8'))
  db.exec(readFileSync(join(MIGRATIONS, 'v0.15_migrate.sql'), 'utf-8'))
  db.pragma('foreign_keys = ON')

  const engram = db.prepare(
    `INSERT INTO engrams (id, mode, type, scope, subject, content, status, properties, created_at, updated_at)
     VALUES (?, ?, ?, 'project.x', ?, ?, ?, ?, '2026-09-01 10:00:00', '2026-09-02 10:00:00')`,
  )
  EPISTEMIC.forEach((type, i) => {
    engram.run(`e-${type}`, 'epistemic', type, type, `an old ${type}`, i === 0 ? 'active' : 'invalidated',
      i === 1 ? null : JSON.stringify({ reasoning: `why ${type}`, source_id: 'x' }))
  })
  engram.run('t-1', 'context', 'task', 'task', 'a task', 'active', '{}')
  engram.run('d-1', 'context', 'decision', 'pick-db', 'we chose sqlite', 'active', '{"rationale":"small"}')

  const edge = db.prepare(
    `INSERT INTO relations (id, source_id, target_id, relation, detection_method, explanation, created_at)
     VALUES (?, ?, ?, ?, 'manual', ?, '2026-09-01 10:00:00')`,
  )
  edge.run('r-eval', 'e-assessment', 'e-prediction', 'evaluates', 'assessment scores the forecast')
  edge.run('r-eval-dup', 'e-observation', 'd-1', 'evaluates', 'redundant with r-rel')
  edge.run('r-rel', 'e-observation', 'd-1', 'related_to', 'already related')
  edge.run('r-sup', 'e-hypothesis', 'd-1', 'supports', 'kept as is')

  db.prepare(`INSERT INTO tags (id, name) VALUES ('schema', 'schema')`).run()
  db.prepare(`INSERT INTO engram_tags (engram_id, tag_id) VALUES ('e-hypothesis', 'schema'), ('d-1', 'schema')`).run()
  db.prepare(`INSERT INTO engram_labels (engram_id, label_id) VALUES ('e-pattern', 'review')`).run()
  db.prepare(`INSERT INTO themes (id, name) VALUES ('loop', 'loop')`).run()
  db.prepare(`INSERT INTO engram_themes (engram_id, theme_id) VALUES ('e-prediction', 'loop')`).run()
  db.prepare(`INSERT INTO task_entries (id, task_id, at, text) VALUES ('te-1', 't-1', '2026-09-03T10:00:00Z', 'progress')`).run()
  db.close()
}

function read(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    // v0.17 renamed engrams.subject → title and engram_themes → engram_subjects;
    // the reader takes either, so the data compares across both renames.
    const v17 = !!db.prepare(`SELECT name FROM sqlite_master WHERE name = 'engram_subjects'`).get()
    const v19 = !!db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries'`).get()
    return {
      engrams: db.prepare(`SELECT id, type, scope, ${v17 ? 'title' : 'subject'} AS title, content, status, significance, properties, created_at, updated_at FROM engrams ORDER BY id`).all() as any[],
      relations: db.prepare('SELECT id, source_id, target_id, relation, explanation FROM relations ORDER BY id').all() as any[],
      tags: db.prepare('SELECT engram_id, tag_id FROM engram_tags ORDER BY engram_id').all(),
      labels: db.prepare('SELECT engram_id, label_id FROM engram_labels ORDER BY engram_id').all(),
      themes: db.prepare(v17
        ? 'SELECT engram_id, subject_id AS theme_id FROM engram_subjects ORDER BY engram_id'
        : 'SELECT engram_id, theme_id FROM engram_themes ORDER BY engram_id').all(),
      // v0.19 turned task_entries into entries (task_id → engram_id)
      entries: db.prepare(v19
        ? 'SELECT id, engram_id AS task_id, text FROM entries ORDER BY id'
        : 'SELECT id, task_id, text FROM task_entries ORDER BY id').all(),
    }
  } finally { db.close() }
}

function schemaFacts(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    const columns = (db.prepare(`PRAGMA table_info(engrams)`).all() as Array<{ name: string }>).map(c => c.name)
    return {
      version: (db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v,
      integrity: db.pragma('integrity_check', { simple: true }),
      fkViolations: (db.pragma('foreign_key_check') as unknown[]).length,
      hasMode: columns.includes('mode'),
      engramIndexes: (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='engrams' AND name LIKE 'idx_%' ORDER BY name`).all() as Array<{ name: string }>).map(r => r.name),
      relationIndexes: (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='relations' AND name LIKE 'idx_%' ORDER BY name`).all() as Array<{ name: string }>).map(r => r.name),
      leftover: db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('engrams_v016','relations_v016','entities_v017','relations_v017')`).get(),
    }
  } finally { db.close() }
}

const EXPECTED = {
  version: CURRENT_BRAIN_SCHEMA_VERSION, integrity: 'ok', fkViolations: 0, hasMode: false,
  engramIndexes: [
    'idx_engrams_core_profile', 'idx_engrams_created', 'idx_engrams_ingested_by', 'idx_engrams_origin', 'idx_engrams_scope',
    'idx_engrams_session', 'idx_engrams_significance', 'idx_engrams_status', 'idx_engrams_title', 'idx_engrams_type',
  ],
  relationIndexes: ['idx_relations_source', 'idx_relations_target', 'idx_relations_type'],
}

/** Data after the migration, compared with the v0.15 state it came from. */
function expectMigratedData(before: ReturnType<typeof read>, after: ReturnType<typeof read>): void {
  // Same engrams, same ids, same content and timestamps; only type + one property differ.
  expect(after.engrams.map(e => e.id)).toEqual(before.engrams.map(e => e.id))
  for (const b of before.engrams) {
    const a = after.engrams.find(e => e.id === b.id)!
    const wasEpistemic = EPISTEMIC.includes(b.type)
    expect({ ...a, type: undefined, properties: undefined }).toEqual({ ...b, type: undefined, properties: undefined })
    if (wasEpistemic) {
      expect(a.type).toBe('note')
      // v0.16 kept the former type in properties.original_epistemic_type; v0.19
      // folds every key a note does not have into detail ("key: value", key order).
      const kept = { ...JSON.parse(b.properties ?? '{}'), original_epistemic_type: b.type } as Record<string, string>
      const detail = Object.keys(kept).sort().map(k => `${k}: ${kept[k]}`).join('\n')
      expect(JSON.parse(a.properties)).toEqual({ detail })
    } else {
      expect(a).toEqual(b)
    }
  }
  // evaluates → related_to; the duplicate of an existing related_to edge is dropped.
  expect(after.relations).toEqual([
    { id: 'r-eval', source_id: 'e-assessment', target_id: 'e-prediction', relation: 'related_to', explanation: 'assessment scores the forecast' },
    { id: 'r-rel', source_id: 'e-observation', target_id: 'd-1', relation: 'related_to', explanation: 'already related' },
    { id: 'r-sup', source_id: 'e-hypothesis', target_id: 'd-1', relation: 'supports', explanation: 'kept as is' },
  ])
  expect(after.tags).toEqual(before.tags)
  expect(after.labels).toEqual(before.labels)
  expect(after.themes).toEqual(before.themes)
  expect(after.entries).toEqual(before.entries)
}

/** The CHECKs after the rebuild: the epistemic types and `evaluates` are gone. */
function expectChecks(file: string): void {
  const db = new Database(file)
  try {
    const ins = db.prepare(`INSERT INTO engrams (id, type, scope, content) VALUES (?, ?, 'project.x', 'c')`)
    expect(() => ins.run('n-new', 'note')).not.toThrow()
    for (const type of EPISTEMIC) expect(() => ins.run(`x-${type}`, type)).toThrow(/CHECK constraint failed/)
    const rel = db.prepare(`INSERT INTO relations (id, source_id, target_id, relation, detection_method) VALUES (?, 't-1', 'd-1', ?, 'manual')`)
    expect(() => rel.run('r-part', 'part_of')).not.toThrow()
    expect(() => rel.run('r-eval-new', 'evaluates')).toThrow(/CHECK constraint failed/)
  } finally { db.close() }
}

describe('v0.16 migration — epistemic mode removed on a seeded v0.15 brain', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-v016-mig-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('the current brain schema is 16 or later', () => {
    expect(CURRENT_BRAIN_SCHEMA_VERSION).toBeGreaterThanOrEqual(16)
  })

  it('through the forward-migration pipeline: epistemic rows become notes, nothing is lost', () => {
    const dataDir = join(dir, 'data')
    mkdirSync(join(dataDir, 'brains'), { recursive: true })
    const brainFile = join(dataDir, 'brains', 'b1.db')
    createV15Brain(brainFile)
    const before = read(brainFile)

    const control = initControlDatabase(':memory:')
    try {
      control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'a@b.de')`).run()
      control.prepare(
        `INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES ('b1', 'test', 'u1', 'brains/b1.db', 15)`,
      ).run()
      const report = runForwardMigrations({ control, dataDir })
      expect(report.outcomes[0]).toMatchObject({ status: 'migrated', kind: 'migrated', appliedVersions: [16, 17, 18, 19] })
      expect((control.prepare(`SELECT schema_version FROM brains WHERE id = 'b1'`).get() as { schema_version: number }).schema_version).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
    } finally { control.close() }

    expectMigratedData(before, read(brainFile))
    expect(schemaFacts(brainFile)).toMatchObject({ ...EXPECTED, leftover: undefined })
    expectChecks(brainFile)
  })

  it('through initDatabase (in-process path): same result', () => {
    const brainFile = join(dir, 'v15.db')
    createV15Brain(brainFile)
    const before = read(brainFile)
    new EML({ namespace: 'test', dbPath: brainFile }).close()
    expectMigratedData(before, read(brainFile))
    expect(schemaFacts(brainFile)).toMatchObject(EXPECTED)
    expectChecks(brainFile)
  })

  it('opening an already-migrated brain does not rebuild engrams again', () => {
    const brainFile = join(dir, 'v15.db')
    createV15Brain(brainFile)
    new EML({ namespace: 'test', dbPath: brainFile }).close()
    const rootpage = () => {
      const db = new Database(brainFile, { readonly: true })
      try { return (db.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'engrams'`).get() as { rootpage: number }).rootpage }
      finally { db.close() }
    }
    const first = rootpage()
    new EML({ namespace: 'test', dbPath: brainFile }).close()
    expect(rootpage()).toBe(first)
  })

  it('a fresh brain is created at the current schema without mode', () => {
    const brainFile = join(dir, 'fresh.db')
    new EML({ namespace: 'test', dbPath: brainFile }).close()
    expect(schemaFacts(brainFile)).toMatchObject(EXPECTED)
  })
})
