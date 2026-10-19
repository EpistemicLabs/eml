import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { initControlDatabase } from '../src/control'
import { runForwardMigrations } from '../src/forward-migrations'

// v0.19 — the tool surface rework. v0.19_migrate.sql rebuilds engrams (learning,
// origin / model / harness), turns task_entries into entries, adds tag / entity
// status and status_tracks, drops projects.tags, and folds every free property
// into the typed fields: significance reset, source_id split by meaning,
// review_note → review entry, renames, core profile, obsolete keys dropped, the
// rest into detail (tasks: into the journal).

const MIGRATIONS = join(__dirname, '..', 'migrations', 'brain')
const V12_FIXTURE = join(__dirname, 'fixtures', 'brain-v12.sql')
const STAMP = '2026-10-02 10:00:00'

type Row = { id: string, type: string, scope: string, title?: string, content?: string, status?: string, significance?: string, properties?: Record<string, unknown>, ingested_by?: string | null }

/** A brain as v0.18 left it, with one row per rewrite case. */
function createV18Brain(file: string): void {
  const db = new Database(file)
  db.exec(readFileSync(V12_FIXTURE, 'utf-8'))
  db.exec(readFileSync(join(MIGRATIONS, 'v0.13_migrate.sql'), 'utf-8'))
  db.pragma('foreign_keys = OFF')
  for (const v of [14, 15, 16, 17, 18]) db.exec(readFileSync(join(MIGRATIONS, `v0.${v}_migrate.sql`), 'utf-8'))
  db.pragma('foreign_keys = ON')

  db.prepare(`INSERT INTO agents (id, name) VALUES ('juno', 'Juno')`).run()
  db.prepare(`INSERT INTO users (id, name) VALUES ('ada', 'Ada')`).run()
  db.prepare(`INSERT INTO projects (id, name, tags, metadata) VALUES ('p1', 'P1', '["alpha","beta"]', '{"repo":"x/y"}')`).run()
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p2', 'P2')`).run()
  db.prepare(`INSERT INTO entities (id, name, kind) VALUES ('acme', 'Acme', 'org')`).run()
  db.prepare(`INSERT INTO tags (id, name) VALUES ('deploy', 'deploy')`).run()

  const insert = db.prepare(
    `INSERT INTO engrams (id, type, scope, title, content, status, significance, properties, ingested_by, created_at, updated_at)
     VALUES (@id, @type, @scope, @title, @content, @status, @significance, @properties, @ingested_by, '2026-10-01 10:00:00', '${STAMP}')`,
  )
  const fts = db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) VALUES (?, ?, ?, ?)`)
  const add = (r: Row) => {
    const row = {
      title: null, content: `content of ${r.id}`, status: 'active', significance: 'normal', ingested_by: null,
      ...r, properties: r.properties ? JSON.stringify(r.properties) : null,
    }
    insert.run(row)
    fts.run(row.id, row.content, row.scope, row.title ?? '')
  }

  // (a) + (b): significance and the three meanings of source_id
  add({ id: 'd-author', type: 'decision', scope: 'project.p1', title: 'd-author', significance: 'critical',
    properties: { rationale: 'r', alternatives: ['x'], review_due_at: '2027-01-01T00:00:00.000Z', source_id: 'juno', source_type: 'agent', decision_type: 'architectural' } })
  add({ id: 'd-author-kept', type: 'decision', scope: 'project.p1', ingested_by: 'ada',
    properties: { rationale: 'r', alternatives: ['x'], source_id: 'juno-claude-code', source_type: 'agent' } })
  add({ id: 'n-pane', type: 'note', scope: 'project.p1', significance: 'high',
    properties: { source_id: 'cockpit-notes', source_type: 'user', user_content_hash: 'abc123' } })
  add({ id: 'n-session', type: 'note', scope: 'project.p1', title: 'n-session',
    properties: { source_id: 'session-2026-10-01-x', source_type: 'agent', hypothesis_type: 'causal' } })
  // (d) review_note
  add({ id: 'r-review', type: 'rule', scope: 'agent.juno', title: 'r-review',
    properties: { applies: 'always', why: 'w', review_note: 'still holds', boot: ['juno'], rule_type: 'guideline', translated_from: 'de' } })
  // (e) renames
  add({ id: 'ref-1', type: 'reference', scope: 'global', title: 'ref-1',
    properties: { source_url: 'https://a.example', url: 'https://b.example', researched_at: '2026-09-01', reference_type: 'paper' } })
  add({ id: 'ref-2', type: 'reference', scope: 'global', title: 'ref-2', properties: { url: 'https://c.example', accessed_at: '2026-09-02' } })
  add({ id: 'ev-1', type: 'event', scope: 'global', title: 'ev-1',
    properties: { occurred_at: '2026-09-03T00:00:00Z', change_type: 'launched', vps_ip: '10.0.0.1' } })
  add({ id: 'd-alt', type: 'decision', scope: 'global', title: 'd-alt', properties: { rationale: 'r', alternatives: 'only one' } })
  // (f) core profile: the newest titled <id> / <id>-identity wins; other scopes and titles are not core
  add({ id: 'p-core-old', type: 'profile', scope: 'agent.juno', title: 'juno', properties: { boot: ['juno'] } })
  add({ id: 'p-facet', type: 'profile', scope: 'agent.juno', title: 'juno-travel' })
  add({ id: 'p-user', type: 'profile', scope: 'user.ada', title: 'ada-identity', properties: { profile_type: 'identity' } })
  add({ id: 'p-gone', type: 'profile', scope: 'user.ada', title: 'ada', status: 'superseded' })
  // (i) tasks: keys without a field go to the journal; standard keys stay
  add({ id: 't-1', type: 'task', scope: 'project.p1', title: 't-1', status: 'resolved',
    properties: { context: 'c', priority: 'high', stage: 'ready', outcome: 'done', resolution: 'shipped it',
      progress_2026_09_23: 'half way', source_id: 'session-2026-09-20-y', source_type: 'agent' } })
  // (i) every other type: into detail, after the existing detail
  add({ id: 's-1', type: 'status', scope: 'project.p2', properties: { state: 'v1', next_step: 'n', runbook_ref: 'docs/run.md' } })
  add({ id: 'l-1', type: 'log', scope: 'project.p1', title: 'l-1', properties: { commits: ['a1', 'b2'], model: 'opus-x', tests_passing: true } })
  add({ id: 'pr-detail', type: 'profile', scope: 'user.ada', title: 'ada-work', properties: { detail: 'first line', merged_from: 'x' } })

  // task journal: an agent entry and a server-written change entry
  const entry = db.prepare(`INSERT INTO task_entries (id, task_id, at, author, stage, text) VALUES (?, 't-1', ?, 'juno', 'ready', ?)`)
  entry.run('e-note', '2026-10-01T11:00:00.000Z', 'Started on the plan.')
  entry.run('e-change', '2026-10-01T12:00:00.000Z', 'decision taken: d-author (0f8fad5b-d9cb-469f-a165-70867728950e)')
  db.close()
}

function engram(db: Database.Database, id: string) {
  const r = db.prepare('SELECT * FROM engrams WHERE id = ?').get(id) as Record<string, any>
  return { ...r, properties: r.properties ? JSON.parse(r.properties) : null }
}

function expectMigrated(file: string): void {
  const db = new Database(file, { readonly: true })
  try {
    expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'task_entries'`).get()).toBeUndefined()

    // (a) significance
    expect(db.prepare(`SELECT DISTINCT significance FROM engrams`).all()).toEqual([{ significance: 'normal' }])

    // (b) source_id by meaning
    const author = engram(db, 'd-author')
    expect(author.ingested_by).toBe('juno')
    expect(author.origin).toBeNull()
    expect(author.properties).toEqual({ rationale: 'r', alternatives: ['x'], review_due_at: '2027-01-01T00:00:00.000Z' })
    expect(engram(db, 'd-author-kept').ingested_by).toBe('ada')
    const pane = engram(db, 'n-pane')
    expect(pane.origin).toBe('cockpit-notes')
    expect(pane.properties).toEqual({ app: { user_content_hash: 'abc123' } })
    const session = engram(db, 'n-session')
    expect(session.origin).toBeNull()
    expect(session.properties).toEqual({ detail: 'hypothesis_type: causal\nsource_id: session-2026-10-01-x' })

    // (d) review_note → review entry; boot, translated_* dropped; a bad rule_type to detail
    const rule = engram(db, 'r-review')
    expect(rule.properties).toEqual({ applies: 'always', why: 'w', detail: 'rule_type: guideline' })
    expect(db.prepare(`SELECT kind, text, at FROM entries WHERE engram_id = 'r-review'`).all())
      .toEqual([{ kind: 'review', text: 'still holds', at: '2026-10-02T10:00:00.000Z' }])

    // (e) renames
    expect(engram(db, 'ref-1').properties).toEqual({ source: 'https://a.example', checked_at: '2026-09-01', detail: 'url: https://b.example' })
    expect(engram(db, 'ref-2').properties).toEqual({ source: 'https://c.example', checked_at: '2026-09-02' })
    expect(engram(db, 'ev-1').properties).toEqual({ occurred_at: '2026-09-03T00:00:00Z', change_type: 'released', detail: 'vps_ip: 10.0.0.1' })
    expect(engram(db, 'd-alt').properties.alternatives).toEqual(['only one'])

    // (f) core profile
    expect(engram(db, 'p-core-old').properties).toEqual({ core: true })
    expect(engram(db, 'p-facet').properties).toBeNull()
    expect(engram(db, 'p-user').properties).toEqual({ core: true })
    expect(engram(db, 'p-gone').properties).toBeNull()

    // (i) task: standard keys stay, the rest is journal
    const task = engram(db, 't-1')
    expect(task.properties).toEqual({ context: 'c', priority: 'high', stage: 'ready', outcome: 'done' })
    expect(db.prepare(`SELECT id, kind, at, author, stage, text FROM entries WHERE engram_id = 't-1' ORDER BY at, rowid`).all()).toEqual([
      // dated from the key
      { id: 't-1-progress_2026_09_23', kind: 'note', at: '2026-09-23T00:00:00.000Z', author: null, stage: 'ready', text: 'progress_2026_09_23: half way' },
      // where the task came from, at its creation
      { id: 't-1-source_id', kind: 'change', at: '2026-10-01T10:00:00.000Z', author: null, stage: 'ready', text: 'legacy source: session-2026-09-20-y' },
      { id: 'e-note', kind: 'note', at: '2026-10-01T11:00:00.000Z', author: 'juno', stage: 'ready', text: 'Started on the plan.' },
      { id: 'e-change', kind: 'change', at: '2026-10-01T12:00:00.000Z', author: 'juno', stage: 'ready', text: 'decision taken: d-author (0f8fad5b-d9cb-469f-a165-70867728950e)' },
      // undated: at the task's last update
      { id: 't-1-resolution', kind: 'note', at: '2026-10-02T10:00:00.000Z', author: null, stage: 'ready', text: 'resolution: shipped it' },
    ])

    // (i) other types: lines in key order after the existing detail
    expect(engram(db, 's-1').properties).toEqual({ state: 'v1', next_step: 'n', detail: 'runbook_ref: docs/run.md' })
    expect(engram(db, 'l-1').properties).toEqual({ detail: 'commits: ["a1","b2"]\nmodel: opus-x\ntests_passing: true' })
    expect(engram(db, 'pr-detail').properties).toEqual({ detail: 'first line\nmerged_from: x' })

    // objects
    expect(db.prepare(`SELECT metadata, status_tracks FROM projects WHERE id = 'p1'`).get())
      .toEqual({ metadata: JSON.stringify({ repo: 'x/y', tags: 'alpha, beta' }), status_tracks: null })
    expect(db.prepare(`SELECT metadata FROM projects WHERE id = 'p2'`).get()).toEqual({ metadata: null })
    expect(db.prepare(`SELECT status, metadata, status_tracks FROM entities WHERE id = 'acme'`).get())
      .toEqual({ status: 'active', metadata: null, status_tracks: null })
    expect(db.prepare(`SELECT status FROM tags WHERE id = 'deploy'`).get()).toEqual({ status: 'active' })

    // search index untouched, one row per engram
    expect((db.prepare('SELECT count(*) AS n FROM engrams_fts').get() as { n: number }).n)
      .toBe((db.prepare('SELECT count(*) AS n FROM engrams').get() as { n: number }).n)
  } finally { db.close() }
}

describe('v0.19 migration — free properties into typed fields', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-v019-mig-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('the current brain schema is 19 or later', () => {
    expect(CURRENT_BRAIN_SCHEMA_VERSION).toBeGreaterThanOrEqual(19)
  })

  it('through the forward-migration pipeline', () => {
    const dataDir = join(dir, 'data')
    mkdirSync(join(dataDir, 'brains'), { recursive: true })
    const brainFile = join(dataDir, 'brains', 'b1.db')
    createV18Brain(brainFile)

    const control = initControlDatabase(':memory:')
    try {
      control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'a@b.de')`).run()
      control.prepare(
        `INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES ('b1', 'test', 'u1', 'brains/b1.db', 18)`,
      ).run()
      const report = runForwardMigrations({ control, dataDir })
      expect(report.outcomes[0]).toMatchObject({ status: 'migrated', kind: 'migrated', appliedVersions: [19] })
    } finally { control.close() }

    expectMigrated(brainFile)
  })

  it('through initDatabase (in-process path): same result', () => {
    const brainFile = join(dir, 'v18.db')
    createV18Brain(brainFile)
    new EML({ namespace: 'test', dbPath: brainFile }).close()
    expectMigrated(brainFile)
  })

  it('a second core-titled profile in the same scope does not break the unique index', () => {
    const brainFile = join(dir, 'v18.db')
    createV18Brain(brainFile)
    const db = new Database(brainFile)
    db.prepare(`INSERT INTO engrams (id, type, scope, title, content, created_at) VALUES ('p-core-new', 'profile', 'agent.juno', 'juno-identity', 'newer', '2026-10-05 10:00:00')`).run()
    db.close()
    new EML({ namespace: 'test', dbPath: brainFile }).close()
    const check = new Database(brainFile, { readonly: true })
    try {
      expect(engram(check, 'p-core-new').properties).toEqual({ core: true })
      expect(engram(check, 'p-core-old').properties).toEqual({})
    } finally { check.close() }
  })
})
