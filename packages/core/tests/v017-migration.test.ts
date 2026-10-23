import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { initControlDatabase } from '../src/control'
import { runForwardMigrations } from '../src/forward-migrations'

// v0.17 — v0.17_migrate.sql is a rename (decision themes-are-subjects): the
// engram field subject becomes title, themes become subjects. The never-used
// entity kind `subject` and detection_method `auto_subject` are dropped (rows
// become `asset` / `manual`). These tests take a seeded v0.16 brain to 17
// through both runners and check that nothing is lost.

const MIGRATIONS = join(__dirname, '..', 'migrations', 'brain')
const V12_FIXTURE = join(__dirname, 'fixtures', 'brain-v12.sql')

/** A brain exactly as v0.16 left it: engrams with subjects, a theme with members, the dropped kinds. */
function createV16Brain(file: string): void {
  const db = new Database(file)
  db.exec(readFileSync(V12_FIXTURE, 'utf-8'))
  db.exec(readFileSync(join(MIGRATIONS, 'v0.13_migrate.sql'), 'utf-8'))
  db.pragma('foreign_keys = OFF')
  for (const v of [14, 15, 16]) db.exec(readFileSync(join(MIGRATIONS, `v0.${v}_migrate.sql`), 'utf-8'))
  db.pragma('foreign_keys = ON')

  const engram = db.prepare(
    `INSERT INTO engrams (id, type, scope, subject, content, created_at, updated_at)
     VALUES (?, ?, 'project.x', ?, ?, '2026-10-01 10:00:00', '2026-10-02 10:00:00')`,
  )
  const fts = db.prepare(`INSERT INTO engrams_fts (id, content, scope, subject) VALUES (?, ?, 'project.x', ?)`)
  for (const [id, type, subject, content] of [
    ['d-1', 'decision', 'pick-db', 'we chose sqlite'],
    ['t-1', 'task', 'release-checklist', 'ship the release'],
    ['n-1', 'note', null, 'a loose thought about sqlite'],
  ] as const) {
    engram.run(id, type, subject, content)
    fts.run(id, content, subject ?? '')
  }
  db.prepare(`INSERT INTO themes (id, name, description) VALUES ('release-0-14', 'release 0.14', 'the 0.14 release')`).run()
  db.prepare(`INSERT INTO engram_themes (engram_id, theme_id) VALUES ('d-1', 'release-0-14'), ('t-1', 'release-0-14')`).run()
  db.prepare(`INSERT INTO entities (id, name, kind) VALUES ('acme', 'Acme', 'org'), ('memory', 'Agent memory', 'subject')`).run()
  db.prepare(
    `INSERT INTO relations (id, source_id, target_id, relation, detection_method)
     VALUES ('r-1', 't-1', 'd-1', 'derived_from', 'manual'), ('r-2', 'n-1', 'd-1', 'related_to', 'auto_subject')`,
  ).run()
  db.close()
}

function read(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    return {
      engrams: db.prepare('SELECT id, type, scope, title, content, created_at, updated_at FROM engrams ORDER BY id').all(),
      subjects: db.prepare('SELECT id, name, description, status FROM subjects ORDER BY id').all(),
      members: db.prepare('SELECT engram_id, subject_id FROM engram_subjects ORDER BY engram_id').all(),
      entities: db.prepare('SELECT id, kind FROM entities ORDER BY id').all(),
      relations: db.prepare('SELECT id, detection_method FROM relations ORDER BY id').all(),
      ftsByTitle: (db.prepare(`SELECT id FROM engrams_fts WHERE engrams_fts MATCH 'title:release'`).all() as Array<{ id: string }>).map(r => r.id),
      ftsCount: (db.prepare('SELECT count(*) AS n FROM engrams_fts').get() as { n: number }).n,
      version: (db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v,
      integrity: db.pragma('integrity_check', { simple: true }),
      fkViolations: (db.pragma('foreign_key_check') as unknown[]).length,
      leftover: db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('themes','engram_themes','entities_v017','relations_v017','idx_engrams_subject')`).get(),
    }
  } finally { db.close() }
}

function expectMigrated(file: string): void {
  expect(read(file)).toEqual({
    engrams: [
      { id: 'd-1', type: 'decision', scope: 'project.x', title: 'pick-db', content: 'we chose sqlite', created_at: '2026-10-01 10:00:00', updated_at: '2026-10-02 10:00:00' },
      { id: 'n-1', type: 'note', scope: 'project.x', title: null, content: 'a loose thought about sqlite', created_at: '2026-10-01 10:00:00', updated_at: '2026-10-02 10:00:00' },
      { id: 't-1', type: 'task', scope: 'project.x', title: 'release-checklist', content: 'ship the release', created_at: '2026-10-01 10:00:00', updated_at: '2026-10-02 10:00:00' },
    ],
    subjects: [{ id: 'release-0-14', name: 'release 0.14', description: 'the 0.14 release', status: 'active' }],
    members: [{ engram_id: 'd-1', subject_id: 'release-0-14' }, { engram_id: 't-1', subject_id: 'release-0-14' }],
    entities: [{ id: 'acme', kind: 'org' }, { id: 'memory', kind: 'asset' }],
    relations: [{ id: 'r-1', detection_method: 'manual' }, { id: 'r-2', detection_method: 'manual' }],
    ftsByTitle: ['t-1'],
    ftsCount: 3,
    version: CURRENT_BRAIN_SCHEMA_VERSION,
    integrity: 'ok',
    fkViolations: 0,
    leftover: undefined,
  })
}

/** The narrower CHECKs and the renamed FK after the migration. */
function expectChecks(file: string): void {
  const db = new Database(file)
  try {
    db.pragma('foreign_keys = ON')
    const entity = db.prepare(`INSERT INTO entities (id, name, kind) VALUES (?, ?, ?)`)
    expect(() => entity.run('x-1', 'x', 'person')).not.toThrow()
    expect(() => entity.run('x-2', 'x', 'subject')).toThrow(/CHECK constraint failed/)
    const rel = db.prepare(`INSERT INTO relations (id, source_id, target_id, relation, detection_method) VALUES (?, 'd-1', 't-1', 'supports', ?)`)
    expect(() => rel.run('r-new', 'auto_subject')).toThrow(/CHECK constraint failed/)
    expect(() => db.prepare(`INSERT INTO engram_subjects (engram_id, subject_id) VALUES ('n-1', 'missing')`).run()).toThrow(/FOREIGN KEY/)
  } finally { db.close() }
}

describe('v0.17 migration — subject → title, themes → subjects on a seeded v0.16 brain', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-v017-mig-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('the current brain schema is 17 or later', () => {
    expect(CURRENT_BRAIN_SCHEMA_VERSION).toBeGreaterThanOrEqual(17)
  })

  it('through the forward-migration pipeline: every row, membership and search entry survives', () => {
    const dataDir = join(dir, 'data')
    mkdirSync(join(dataDir, 'brains'), { recursive: true })
    const brainFile = join(dataDir, 'brains', 'b1.db')
    createV16Brain(brainFile)

    const control = initControlDatabase(':memory:')
    try {
      control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'a@b.de')`).run()
      control.prepare(
        `INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES ('b1', 'test', 'u1', 'brains/b1.db', 16)`,
      ).run()
      const report = runForwardMigrations({ control, dataDir })
      expect(report.outcomes[0]).toMatchObject({ status: 'migrated', kind: 'migrated', appliedVersions: [17, 18, 19, 20] })
    } finally { control.close() }

    expectMigrated(brainFile)
    expectChecks(brainFile)
  })

  it('through initDatabase (in-process path): same result', () => {
    const brainFile = join(dir, 'v16.db')
    createV16Brain(brainFile)
    new EML({ namespace: 'test', dbPath: brainFile }).close()
    expectMigrated(brainFile)
    expectChecks(brainFile)
  })

  it('the API reads the migrated brain under the new names', () => {
    const brainFile = join(dir, 'v16.db')
    createV16Brain(brainFile)
    const eml = new EML({ namespace: 'test', dbPath: brainFile })
    try {
      const d = eml.engrams.getRaw('d-1')!
      expect(d.title).toBe('pick-db')
      expect(d.subjects).toEqual(['release-0-14'])
      expect(eml.engrams.query({ title: 'release-checklist' }).map(e => e.id)).toEqual(['t-1'])
      expect(eml.engrams.query({ subject: 'release-0-14' }).map(e => e.id).sort()).toEqual(['d-1', 't-1'])
    } finally { eml.close() }
  })
})
