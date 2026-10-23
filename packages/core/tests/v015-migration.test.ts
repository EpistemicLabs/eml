import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { initControlDatabase } from '../src/control'
import { runForwardMigrations } from '../src/forward-migrations'
import { writes } from './fixtures'

// v0.15 Cluster B — v0.15_migrate.sql rebuilds `relations` (the `part_of` verb
// joins the CHECK) and adds the `task_entries` table. These tests take a seeded
// v0.14 brain to 15 through both runners and check that every relation, tag and
// label survives, the CHECK takes `part_of` and still rejects junk, and an
// already-current brain is not rebuilt again. Both runners now continue to the
// current schema (v0.16 follows), so the fixture avoids `evaluates`, which v0.16
// rewrites — v016-migration.test.ts covers that step.

const MIGRATIONS = join(__dirname, '..', 'migrations', 'brain')
const V12_FIXTURE = join(__dirname, 'fixtures', 'brain-v12.sql')
const VERBS = ['supports', 'contradicts', 'supersedes', 'derived_from', 'refines', 'related_to', 'blocks']

/** A brain exactly as v0.14 left it, with one edge per verb plus tags and labels. */
function createV14Brain(file: string): void {
  const db = new Database(file)
  db.exec(readFileSync(V12_FIXTURE, 'utf-8'))
  db.exec(readFileSync(join(MIGRATIONS, 'v0.13_migrate.sql'), 'utf-8'))
  db.pragma('foreign_keys = OFF')
  db.exec(readFileSync(join(MIGRATIONS, 'v0.14_migrate.sql'), 'utf-8'))
  db.pragma('foreign_keys = ON')

  const engram = db.prepare(
    `INSERT INTO engrams (id, mode, type, scope, subject, content, status, properties) VALUES (?, 'context', ?, 'project.x', ?, ?, ?, '{}')`,
  )
  engram.run('t-parent', 'task', 'parent', 'the parent task', 'active')
  engram.run('t-child', 'task', 'child', 'the child task', 'planned')
  engram.run('d-1', 'decision', 'pick-db', 'we chose sqlite', 'active')
  engram.run('n-1', 'note', 'notes', 'a note', 'active')
  VERBS.forEach((verb, i) => {
    db.prepare(
      `INSERT INTO relations (id, source_id, target_id, relation, detection_method, explanation, created_at)
       VALUES (?, 'n-1', 'd-1', ?, 'manual', ?, '2026-09-01 10:00:00')`,
    ).run(`r-${i}`, verb, `edge ${verb}`)
  })
  db.prepare(`INSERT INTO tags (id, name) VALUES ('schema', 'schema')`).run()
  db.prepare(`INSERT INTO engram_tags (engram_id, tag_id) VALUES ('d-1', 'schema')`).run()
  db.prepare(`INSERT INTO engram_labels (engram_id, label_id) VALUES ('d-1', 'review')`).run()
  db.close()
}

function snapshot(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    return {
      engrams: db.prepare('SELECT id, type, status, properties, created_at, updated_at FROM engrams ORDER BY id').all(),
      relations: db.prepare('SELECT id, source_id, target_id, relation, detection_method, strength, explanation, metadata, created_at FROM relations ORDER BY id').all(),
      tags: db.prepare('SELECT engram_id, tag_id FROM engram_tags ORDER BY engram_id').all(),
      labels: db.prepare('SELECT engram_id, label_id FROM engram_labels ORDER BY engram_id').all(),
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
      relationIndexes: (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='relations' AND name LIKE 'idx_%' ORDER BY name`).all() as Array<{ name: string }>).map(r => r.name),
      taskEntries: !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='entries'`).get(), // the journal table since v0.19
      leftover: db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('relations_v015','relations_v016','relations_v017')`).get(),
    }
  } finally { db.close() }
}

const EXPECTED = {
  version: CURRENT_BRAIN_SCHEMA_VERSION, integrity: 'ok', fkViolations: 0, taskEntries: true,
  relationIndexes: ['idx_relations_source', 'idx_relations_target', 'idx_relations_type'],
}

/** The CHECK after the rebuild: part_of in, junk out. */
function expectRelationCheck(file: string): void {
  const db = new Database(file)
  try {
    const ins = db.prepare(`INSERT INTO relations (id, source_id, target_id, relation, detection_method) VALUES (?, 't-child', 't-parent', ?, 'manual')`)
    expect(() => ins.run('r-part', 'part_of')).not.toThrow()
    expect(() => ins.run('r-junk', 'belongs_to')).toThrow(/CHECK constraint failed/)
  } finally { db.close() }
}

describe('v0.15 migration — relations rebuild + task_entries on a seeded v0.14 brain', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-v015-mig-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('through the forward-migration pipeline: every relation, tag and label survives', () => {
    const dataDir = join(dir, 'data')
    mkdirSync(join(dataDir, 'brains'), { recursive: true })
    const brainFile = join(dataDir, 'brains', 'b1.db')
    createV14Brain(brainFile)
    const before = snapshot(brainFile)
    expect(before.relations).toHaveLength(VERBS.length)

    const control = initControlDatabase(':memory:')
    try {
      control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'a@b.de')`).run()
      control.prepare(
        `INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES ('b1', 'test', 'u1', 'brains/b1.db', 14)`,
      ).run()
      const report = runForwardMigrations({ control, dataDir })
      expect(report.outcomes[0]).toMatchObject({ status: 'migrated', kind: 'migrated', appliedVersions: [15, 16, 17, 18, 19, 20] })
      expect((control.prepare(`SELECT schema_version FROM brains WHERE id = 'b1'`).get() as { schema_version: number }).schema_version).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
    } finally { control.close() }

    expect(snapshot(brainFile)).toEqual(before)
    const facts = schemaFacts(brainFile)
    expect(facts).toMatchObject(EXPECTED)
    expect(facts.leftover).toBeUndefined()
    expectRelationCheck(brainFile)
  })

  it('through initDatabase (CLI / provisioning path): same result, task entries work', () => {
    const brainFile = join(dir, 'v14.db')
    createV14Brain(brainFile)
    const before = snapshot(brainFile)

    const eml = new EML({ namespace: 'test', dbPath: brainFile })
    try {
      // v0.19: part_of comes from a task's parent (trackTask), entries from trackTask text.
      writes(eml).trackTask('t-child', { parent_id: 't-parent' }, eml.env({ handle: 'assistant' }))
      const tracked = writes(eml).trackTask('t-parent', { text: 'first entry after the update' }, eml.env({ handle: 'assistant' }))!
      expect(tracked.entries_written![0].author).toBe('assistant')
    } finally { eml.close() }

    const after = snapshot(brainFile)
    expect(after.relations.filter((r: any) => r.relation !== 'part_of')).toEqual(before.relations)
    expect(after.tags).toEqual(before.tags)
    expect(after.labels).toEqual(before.labels)
    expect(schemaFacts(brainFile)).toMatchObject(EXPECTED)
  })

  it('opening an already-migrated brain does not rebuild relations again', () => {
    const brainFile = join(dir, 'v14.db')
    createV14Brain(brainFile)
    new EML({ namespace: 'test', dbPath: brainFile }).close()
    const rootpage = () => {
      const db = new Database(brainFile, { readonly: true })
      try { return (db.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'relations'`).get() as { rootpage: number }).rootpage }
      finally { db.close() }
    }
    const first = rootpage()
    new EML({ namespace: 'test', dbPath: brainFile }).close()
    expect(rootpage()).toBe(first)
  })

  it('a fresh brain is created at the current schema with part_of and task_entries', () => {
    const brainFile = join(dir, 'fresh.db')
    new EML({ namespace: 'test', dbPath: brainFile }).close()
    expect(schemaFacts(brainFile)).toMatchObject(EXPECTED)
  })
})
