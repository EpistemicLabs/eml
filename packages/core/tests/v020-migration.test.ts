import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION, initControlDatabase, runForwardMigrations } from '../src'

// Schema 20 (release F1): every timestamp rewritten to ISO-8601 UTC ms and the
// clock defaults dropped, expired → invalidated, expires_at removed,
// review_due_at normalized, the labels axis dropped, engrams.rev added.
// Nothing is lost: every row of every remaining table survives.

const V19_FIXTURE = join(__dirname, 'fixtures', 'brain-v19.sql')
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const NOW = '2026-10-23T12:00:00.000Z'
const TABLES = ['agents', 'users', 'entities', 'projects', 'engrams', 'relations', 'tags', 'engram_tags', 'subjects', 'engram_subjects', 'entries']

/** A brain as v0.19 left it: SQLite-format and ISO timestamps mixed, expired rows, a review label, date-only review dates. */
function createV19Brain(file: string): void {
  const db = new Database(file)
  db.exec(readFileSync(V19_FIXTURE, 'utf-8'))
  db.exec(`
    INSERT INTO agents (id, name) VALUES ('juno', 'Juno');
    INSERT INTO users (id, name) VALUES ('ada', 'Ada');
    INSERT INTO entities (id, name, kind, created_at, updated_at) VALUES ('acme', 'Acme', 'org', '2026-08-01T09:00:00Z', '2026-08-02T09:00:00.123Z');
    INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p', 'P', '2026-07-01 08:00:00', '2026-07-02 08:00:00');
    INSERT INTO tags (id, name) VALUES ('ops', 'ops');
    INSERT INTO subjects (id, name) VALUES ('launch', 'launch');
  `)
  const engram = db.prepare(`INSERT INTO engrams (id, type, scope, title, content, status, properties, created_at, updated_at)
    VALUES (?, ?, 'project.p', ?, ?, ?, ?, ?, ?)`)
  engram.run('d-sqlite', 'decision', 'd-sqlite', 'sqlite timestamps', 'active', JSON.stringify({ rationale: 'r', alternatives: ['a'], review_due_at: '2026-10-01 10:00:00' }), '2026-08-01 10:00:00', '2026-08-02 10:00:00')
  engram.run('d-date', 'decision', 'd-date', 'a date-only review', 'active', JSON.stringify({ rationale: 'r', alternatives: ['a'], review_due_at: '2026-10-22' }), '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z')
  engram.run('d-future', 'decision', 'd-future', 'not due yet', 'active', JSON.stringify({ rationale: 'r', alternatives: ['a'], review_due_at: '2027-01-01T00:00:00.000Z' }), '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z')
  engram.run('d-expired', 'decision', 'd-expired', 'an expired decision with sqlite', 'expired', JSON.stringify({ rationale: 'r', alternatives: ['a'], expires_at: '2026-09-01', review_due_at: '2026-09-01' }), '2026-08-01 10:00:00', '2026-09-02 10:00:00')
  engram.run('r-expired', 'rule', 'r-expired', 'an expired rule', 'expired', JSON.stringify({ applies: 'always', why: 'w' }), '2026-08-01 10:00:00', '2026-08-03 10:00:00')
  engram.run('t-idle', 'task', 't-idle', 'an idle task', 'active', JSON.stringify({ stage: 'planning' }), '2026-07-01 10:00:00', '2026-07-01 10:00:00')
  engram.run('t-moving', 'task', 't-moving', 'a task with a recent entry', 'active', '{}', '2026-07-01 10:00:00', '2026-07-01 10:00:00')
  engram.run('n-offset', 'note', 'n-offset', 'a timestamp with an offset', 'active', null, '2026-08-01T12:00:00+02:00', '2026-08-01T12:00:00+02:00')
  for (const id of ['d-sqlite', 'd-date', 'd-future', 'd-expired', 'r-expired', 't-idle', 't-moving', 'n-offset']) {
    db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) SELECT id, content, scope, COALESCE(title, '') FROM engrams WHERE id = ?`).run(id)
  }
  db.exec(`
    INSERT INTO relations (id, source_id, target_id, relation, detection_method) VALUES ('rel-1', 'd-sqlite', 'd-date', 'supports', 'manual');
    INSERT INTO engram_tags (engram_id, tag_id) VALUES ('d-sqlite', 'ops');
    INSERT INTO engram_subjects (engram_id, subject_id) VALUES ('t-idle', 'launch');
    INSERT INTO engram_labels (engram_id, label_id) VALUES ('d-sqlite', 'review');
    INSERT INTO entries (id, engram_id, kind, at, text) VALUES ('e-1', 't-moving', 'note', '2026-10-20 10:00:00', 'still on it');
    INSERT INTO entries (id, engram_id, kind, at, text) VALUES ('e-2', 't-idle', 'change', '2026-07-01T10:00:00.000Z', 'created (active)');
  `)
  db.close()
}

function counts(file: string): Record<string, number> {
  const db = new Database(file, { readonly: true })
  try { return Object.fromEntries(TABLES.map(t => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n])) } finally { db.close() }
}

/** Review due under v0.19's rules (datetime()-normalized compares), for the fixed NOW — what the sweep would have stamped. */
function reviewDueV19(file: string): string[] {
  const db = new Database(file, { readonly: true })
  try {
    return (db.prepare(`
      SELECT c.id FROM engrams c WHERE c.status = 'active' AND (
        (c.type IN ('decision', 'rule', 'profile') AND json_extract(c.properties, '$.review_due_at') IS NOT NULL
          AND datetime(json_extract(c.properties, '$.review_due_at')) < datetime(?)
          AND coalesce(json_extract(c.properties, '$.binding'), 'standing') = 'standing')
        OR (c.type = 'task' AND MAX(datetime(c.updated_at), COALESCE(datetime((SELECT MAX(te.at) FROM entries te WHERE te.engram_id = c.id)), datetime(c.updated_at)))
          < datetime(?, '-30 days'))
      ) ORDER BY c.id`).all(NOW, NOW) as Array<{ id: string }>).map(r => r.id)
  } finally { db.close() }
}

function expectMigrated(file: string, before: { counts: Record<string, number>, due: string[] }): void {
  expect(counts(file)).toEqual(before.counts)
  const db = new Database(file, { readonly: true })
  try {
    expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(20)
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect((db.pragma('foreign_key_check') as unknown[]).length).toBe(0)
    // the labels axis is gone, nothing else
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('labels', 'engram_labels')`).all()).toEqual([])
    // expired → invalidated; expires_at gone
    expect(db.prepare(`SELECT id, status FROM engrams WHERE id IN ('d-expired', 'r-expired') ORDER BY id`).all())
      .toEqual([{ id: 'd-expired', status: 'invalidated' }, { id: 'r-expired', status: 'invalidated' }])
    expect((db.prepare(`SELECT COUNT(*) AS n FROM engrams WHERE status = 'expired' OR json_extract(properties, '$.expires_at') IS NOT NULL`).get() as { n: number }).n).toBe(0)
    // every timestamp ISO-8601 UTC ms; the values kept (SQLite format and offsets are UTC-equal)
    for (const [table, cols] of [['agents', ['created_at']], ['users', ['created_at', 'updated_at']], ['entities', ['created_at', 'updated_at']],
      ['projects', ['created_at', 'updated_at']], ['engrams', ['created_at', 'updated_at']], ['relations', ['created_at']], ['tags', ['created_at']],
      ['engram_tags', ['created_at']], ['subjects', ['created_at', 'updated_at']], ['engram_subjects', ['created_at']], ['entries', ['at']]] as const) {
      for (const col of cols) {
        for (const r of db.prepare(`SELECT ${col} AS v FROM ${table}`).all() as Array<{ v: string }>) expect(r.v, `${table}.${col}`).toMatch(ISO)
      }
    }
    const engram = (id: string) => db.prepare('SELECT created_at, updated_at, properties, rev FROM engrams WHERE id = ?').get(id) as { created_at: string, updated_at: string, properties: string, rev: number }
    expect(engram('d-sqlite')).toMatchObject({ created_at: '2026-08-01T10:00:00.000Z', updated_at: '2026-08-02T10:00:00.000Z', rev: 1 })
    expect(engram('n-offset')).toMatchObject({ created_at: '2026-08-01T10:00:00.000Z' })
    expect((db.prepare(`SELECT updated_at FROM entities WHERE id = 'acme'`).get() as { updated_at: string }).updated_at).toBe('2026-08-02T09:00:00.123Z')
    expect((db.prepare(`SELECT at FROM entries WHERE id = 'e-1'`).get() as { at: string }).at).toBe('2026-10-20T10:00:00.000Z')
    // review_due_at normalized, the other fields untouched
    expect(JSON.parse(engram('d-sqlite').properties)).toEqual({ rationale: 'r', alternatives: ['a'], review_due_at: '2026-10-01T10:00:00.000Z' })
    expect(JSON.parse(engram('d-date').properties).review_due_at).toBe('2026-10-22T00:00:00.000Z')
    expect(JSON.parse(engram('d-expired').properties)).toEqual({ rationale: 'r', alternatives: ['a'], review_due_at: '2026-09-01T00:00:00.000Z' })
    // the search index survives the rebuild
    expect(db.prepare(`SELECT id FROM engrams_fts WHERE engrams_fts MATCH 'offset'`).all()).toEqual([{ id: 'n-offset' }])
  } finally { db.close() }
  // review_due as computed now = what v0.19's rules said, for the same clock
  const eml = new EML({ namespace: 'test', dbPath: file, clock: () => NOW })
  try {
    expect(eml.engrams.query({ review_due: true, limit: 100 }).map(e => e.id).sort()).toEqual(before.due)
    expect(before.due).toEqual(['d-date', 'd-sqlite', 't-idle'])
  } finally { eml.close() }
}

describe('v0.20 migration — schema 20 on a seeded v0.19 brain', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-v020-mig-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('through initDatabase (in-process path)', () => {
    const file = join(dir, 'v19.db')
    createV19Brain(file)
    const before = { counts: counts(file), due: reviewDueV19(file) }
    new EML({ namespace: 'test', dbPath: file }).close()
    expectMigrated(file, before)
  })

  it('through the forward-migration pipeline', () => {
    const dataDir = join(dir, 'data')
    mkdirSync(join(dataDir, 'brains'), { recursive: true })
    const file = join(dataDir, 'brains', 'b1.db')
    createV19Brain(file)
    const before = { counts: counts(file), due: reviewDueV19(file) }
    const control = initControlDatabase(':memory:')
    try {
      control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'a@b.de')`).run()
      control.prepare(`INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES ('b1', 'test', 'u1', 'brains/b1.db', 19)`).run()
      const report = runForwardMigrations({ control, dataDir })
      expect(report.outcomes[0]).toMatchObject({ status: 'migrated', kind: 'migrated', appliedVersions: [20] })
      expect(CURRENT_BRAIN_SCHEMA_VERSION).toBe(20)
    } finally { control.close() }
    expectMigrated(file, before)
  })

  it('a migrated brain writes on: no clock default is needed', () => {
    const file = join(dir, 'v19.db')
    createV19Brain(file)
    const eml = new EML({ namespace: 'test', dbPath: file, clock: () => NOW })
    try {
      const r = eml.apply({ name: 'engram.update', input: { id: 'd-sqlite', patch: { content: 'reworded' }, base_rev: 1 } })
      expect(r).toMatchObject({ updated_at: NOW, rev: 2 })
      expect(eml.apply({ name: 'object.create', input: { object: 'tag', fields: { name: 'new-tag' } } }).object).toMatchObject({ created_at: NOW })
    } finally { eml.close() }
  })
})
