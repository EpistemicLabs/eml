import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { initControlDatabase } from '../src/control'
import { runForwardMigrations } from '../src/forward-migrations'
import { writes } from './fixtures'

// v0.14 Cluster A — the `note` type (decision engram-type-check-in-db). The type
// CHECK lives in the DB, so v0.14_migrate.sql rebuilds `engrams`; these tests
// cover the type itself and that the rebuild keeps every linked row.

const MIGRATIONS = join(__dirname, '..', 'migrations', 'brain')
const V12_FIXTURE = join(__dirname, 'fixtures', 'brain-v12.sql')

/** A brain exactly as v0.13 left it, seeded with engrams + every kind of link. */
function createV13Brain(file: string): void {
  const db = new Database(file)
  db.exec(readFileSync(V12_FIXTURE, 'utf-8'))
  db.exec(readFileSync(join(MIGRATIONS, 'v0.13_migrate.sql'), 'utf-8'))
  const engram = db.prepare(
    `INSERT INTO engrams (id, mode, type, scope, subject, content, properties) VALUES (?, 'context', ?, 'project.x', ?, ?, '{}')`,
  )
  engram.run('e-decision', 'decision', 'pick-db', 'we chose sqlite')
  engram.run('e-reference', 'reference', 'spec-link', 'the spec lives at example.org')
  engram.run('e-rule', 'rule', 'no-workarounds', 'fix root causes')
  db.prepare(`INSERT INTO tags (id, name) VALUES ('schema', 'schema')`).run()
  db.prepare(`INSERT INTO engram_tags (engram_id, tag_id) VALUES ('e-decision', 'schema'), ('e-rule', 'schema')`).run()
  db.prepare(`INSERT INTO engram_labels (engram_id, label_id) VALUES ('e-decision', 'review')`).run()
  db.prepare(
    `INSERT INTO relations (id, source_id, target_id, relation, detection_method) VALUES ('r1', 'e-rule', 'e-decision', 'derived_from', 'manual')`,
  ).run()
  const fts = db.prepare(`INSERT INTO engrams_fts (id, content, scope, subject) VALUES (?, ?, 'project.x', ?)`)
  fts.run('e-decision', 'we chose sqlite', 'pick-db')
  fts.run('e-reference', 'the spec lives at example.org', 'spec-link')
  fts.run('e-rule', 'fix root causes', 'no-workarounds')
  db.close()
}

/** Everything the rebuild must keep, as one comparable snapshot. */
function snapshot(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    // v0.17 renamed engrams.subject to title; the snapshot reads either.
    const titleCol = (db.prepare(`SELECT name FROM pragma_table_info('engrams') WHERE name IN ('subject', 'title')`).get() as { name: string }).name
    return {
      engrams: db.prepare(`SELECT id, type, scope, ${titleCol} AS title, content, status, significance, properties, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AS created_at, strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AS updated_at FROM engrams ORDER BY id`).all(),
      tags: db.prepare('SELECT engram_id, tag_id FROM engram_tags ORDER BY engram_id, tag_id').all(),
      relations: db.prepare('SELECT id, source_id, target_id, relation FROM relations ORDER BY id').all(),
      fts: db.prepare(`SELECT id FROM engrams_fts WHERE engrams_fts MATCH 'sqlite'`).all(),
    }
  } finally { db.close() }
}

function schemaFacts(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    return {
      version: (db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v,
      integrity: db.pragma('integrity_check', { simple: true }),
      fkViolations: (db.pragma('foreign_key_check') as unknown[]).length,
      indexes: (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='engrams' AND name LIKE 'idx_%' ORDER BY name`).all() as Array<{ name: string }>).map(r => r.name),
      leftover: db.prepare(`SELECT name FROM sqlite_master WHERE name = 'engrams_v014'`).get(),
    }
  } finally { db.close() }
}

// After v0.14 the engrams table still carries idx_engrams_mode (v0.16 drops it)
// and idx_engrams_subject (v0.17 renames it to idx_engrams_title).
const V14_INDEXES = [
  'idx_engrams_created', 'idx_engrams_ingested_by', 'idx_engrams_mode', 'idx_engrams_scope',
  'idx_engrams_significance', 'idx_engrams_status', 'idx_engrams_subject', 'idx_engrams_type',
]
// v0.19 adds idx_engrams_core_profile, idx_engrams_origin and idx_engrams_session.
const EXPECTED_INDEXES = [
  'idx_engrams_core_profile', 'idx_engrams_created', 'idx_engrams_ingested_by', 'idx_engrams_origin', 'idx_engrams_scope',
  'idx_engrams_session', 'idx_engrams_significance', 'idx_engrams_status', 'idx_engrams_title', 'idx_engrams_type',
]

describe('v0.14 note type', () => {
  let dir: string
  let eml: EML

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eml-note-test-'))
    eml = new EML({ namespace: 'test', dbPath: join(dir, 't.db') })
  })
  afterEach(() => {
    eml.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('brain schema version includes v0.14', () => {
    expect(CURRENT_BRAIN_SCHEMA_VERSION).toBeGreaterThanOrEqual(14)
    expect(schemaFacts(join(dir, 't.db')).version).toBe(CURRENT_BRAIN_SCHEMA_VERSION)  // fresh brain → current (v0.15: 15)
  })

  it('stores a note: active, no review date', () => {
    const e = writes(eml).store({
      type: 'note', scope: 'global', title: 'thesis', content: 'subjects beat hand-drawn edges',
    })
    expect(e.type).toBe('note')
    expect(e.status).toBe('active')
    expect((e.properties as Record<string, unknown>).review_due_at).toBeUndefined()
    expect(eml.engrams.query({ type: 'note' }).map(x => x.id)).toEqual([e.id])
  })

  it('reference is still a valid type', () => {
    const e = writes(eml).store({
      type: 'reference', scope: 'global', title: 'the-spec', content: 'the spec',
      properties: { source: 'https://example.org/spec' },
    })
    expect(e.type).toBe('reference')
  })

  it('the DB still refuses unknown types (the CHECK is kept, not dropped)', () => {
    const db = new Database(join(dir, 't.db'))
    try {
      expect(() => db.prepare(
        `INSERT INTO engrams (id, type, scope, content, created_at, updated_at, rev) VALUES ('bad', 'bogus', 'global', 'x', 'now', 'now', 1)`,
      ).run()).toThrow(/CHECK constraint failed/)
    } finally { db.close() }
  })
})

describe('v0.14 migration — engrams rebuild on a seeded v0.13 brain', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-v014-mig-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('through the forward-migration pipeline: every row and link survives, note becomes writable', () => {
    const dataDir = join(dir, 'data')
    mkdirSync(join(dataDir, 'brains'), { recursive: true })
    const brainFile = join(dataDir, 'brains', 'b1.db')
    createV13Brain(brainFile)
    const before = snapshot(brainFile)

    const control = initControlDatabase(':memory:')
    try {
      control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'a@b.de')`).run()
      control.prepare(
        `INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES ('b1', 'test', 'u1', 'brains/b1.db', 13)`,
      ).run()

      const report = runForwardMigrations({ control, dataDir, targetVersion: 14 })
      expect(report.outcomes[0]).toMatchObject({ status: 'migrated', kind: 'migrated', appliedVersions: [14] })
      expect((control.prepare(`SELECT schema_version FROM brains WHERE id = 'b1'`).get() as { schema_version: number }).schema_version).toBe(14)
    } finally { control.close() }

    expect(snapshot(brainFile)).toEqual(before)
    expect(before.tags).toHaveLength(2)
    expect(before.fts).toEqual([{ id: 'e-decision' }])

    const facts = schemaFacts(brainFile)
    expect(facts).toMatchObject({ version: 14, integrity: 'ok', fkViolations: 0, indexes: V14_INDEXES })
    expect(facts.leftover).toBeUndefined()

    const eml = new EML({ namespace: 'test', dbPath: brainFile })
    try {
      const n = writes(eml).store({ type: 'note', scope: 'global', title: 'after-rebuild', content: 'a note after the rebuild' })
      expect(n.type).toBe('note')
    } finally { eml.close() }
  })

  it('through initDatabase (CLI / provisioning path): FKs are off during the rebuild, links survive', () => {
    const brainFile = join(dir, 'v13.db')
    createV13Brain(brainFile)
    const before = snapshot(brainFile)

    const eml = new EML({ namespace: 'test', dbPath: brainFile })   // initDatabase → tail → current (v0.14, v0.15)
    eml.close()

    // With FKs on, DROP TABLE engrams would have cascade-deleted engram_tags / engram_labels.
    expect(snapshot(brainFile)).toEqual(before)
    expect(schemaFacts(brainFile)).toMatchObject({ version: CURRENT_BRAIN_SCHEMA_VERSION, integrity: 'ok', fkViolations: 0, indexes: EXPECTED_INDEXES })
  })

  it('opening an already-migrated brain does not rebuild again', () => {
    const brainFile = join(dir, 'v13.db')
    createV13Brain(brainFile)
    new EML({ namespace: 'test', dbPath: brainFile }).close()

    const db = new Database(brainFile)
    const rootpage = () => (db.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'engrams'`).get() as { rootpage: number }).rootpage
    const first = rootpage()
    db.close()

    new EML({ namespace: 'test', dbPath: brainFile }).close()

    const again = new Database(brainFile, { readonly: true })
    try {
      expect((again.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'engrams'`).get() as { rootpage: number }).rootpage).toBe(first)
    } finally { again.close() }
  })
})
