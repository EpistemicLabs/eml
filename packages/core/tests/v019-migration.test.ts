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
// review_note → review entry, renames, core profile, supersedes keys → edges,
// boot dropped, the rest into detail (tasks: into the journal). Nothing
// disappears silently: a value either finds its field, becomes an edge or an
// entry, or stays readable in detail / the journal.

const MIGRATIONS = join(__dirname, '..', 'migrations', 'brain')
const V12_FIXTURE = join(__dirname, 'fixtures', 'brain-v12.sql')
const STAMP = '2026-10-02 10:00:00'

type Row = {
  id: string, type: string, scope: string, title?: string, content?: string, status?: string, significance?: string,
  /** an object, or the raw column text for a malformed value */
  properties?: Record<string, unknown> | string, ingested_by?: string | null, created_at?: string,
}

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
  // metadata: values of every JSON type; no JSON object at all; tags key taken
  db.prepare(`INSERT INTO projects (id, name, tags, metadata) VALUES ('p3', 'P3', '["x"]', '{"infra":{"host":"h"},"parts":["a","b"],"n":3,"live":true}')`).run()
  db.prepare(`INSERT INTO projects (id, name, metadata) VALUES ('p4', 'P4', 'not json')`).run()
  db.prepare(`INSERT INTO projects (id, name, tags, metadata) VALUES ('p5', 'P5', '["a"]', '{"tags":"old"}')`).run()
  db.prepare(`INSERT INTO entities (id, name, kind) VALUES ('acme', 'Acme', 'org')`).run()
  db.prepare(`INSERT INTO tags (id, name) VALUES ('deploy', 'deploy')`).run()

  const insert = db.prepare(
    `INSERT INTO engrams (id, type, scope, title, content, status, significance, properties, ingested_by, created_at, updated_at)
     VALUES (@id, @type, @scope, @title, @content, @status, @significance, @properties, @ingested_by, @created_at, '${STAMP}')`,
  )
  const fts = db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) VALUES (?, ?, ?, ?)`)
  const add = (r: Row) => {
    const row = {
      title: null, content: `content of ${r.id}`, status: 'active', significance: 'normal', ingested_by: null, created_at: '2026-10-01 10:00:00',
      ...r, properties: typeof r.properties === 'string' ? r.properties : r.properties ? JSON.stringify(r.properties) : null,
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
  // (b) a second author is not the writer; <agent>-claude-code is the agent
  add({ id: 'n-two-authors', type: 'note', scope: 'project.p1', ingested_by: 'juno', properties: { source_id: 'ada', source_type: 'user' } })
  add({ id: 't-2', type: 'task', scope: 'project.p1', title: 't-2', ingested_by: 'ada', properties: { stage: 'ready', source_id: 'juno' } })
  add({ id: 'n-cc', type: 'note', scope: 'project.p1', properties: { source_id: 'juno-claude-code', source_type: 'agent' } })
  // (b) a v0.18 seed: the marker goes to origin, source_type system says the same
  add({ id: 'r-seed', type: 'rule', scope: 'agent.juno', title: 'r-seed', properties: { applies: 'always', source_id: 'eml-default-brain', source_type: 'system' } })
  // (d) review_note: a review entry on an active rule; history on a superseded decision and on a reference
  add({ id: 'r-review', type: 'rule', scope: 'agent.juno', title: 'r-review',
    properties: { applies: 'always', why: 'w', review_note: 'still holds', boot: ['juno'], rule_type: 'guideline', translated_from: 'de' } })
  // (e) renames
  add({ id: 'ref-1', type: 'reference', scope: 'global', title: 'ref-1',
    properties: { source_url: 'https://a.example', url: 'https://b.example', researched_at: '2026-09-01', reference_type: 'paper' } })
  add({ id: 'ref-2', type: 'reference', scope: 'global', title: 'ref-2', properties: { url: 'https://c.example', accessed_at: '2026-09-02', review_note: 'checked' } })
  add({ id: 'ev-1', type: 'event', scope: 'global', title: 'ev-1',
    properties: { occurred_at: '2026-09-03T00:00:00Z', change_type: 'launched', vps_ip: '10.0.0.1', renamed_reason: 'was launch' } })
  add({ id: 'd-alt', type: 'decision', scope: 'global', title: 'd-alt', properties: { rationale: 'r', alternatives: 'only one' } })
  // (f) core profile: the newest titled <id> / <id>-identity wins; other scopes and titles are not core
  add({ id: 'p-core-old', type: 'profile', scope: 'agent.juno', title: 'juno', properties: { boot: ['juno'] } })
  add({ id: 'p-facet', type: 'profile', scope: 'agent.juno', title: 'juno-travel' })
  add({ id: 'p-user', type: 'profile', scope: 'user.ada', title: 'ada-identity', properties: { profile_type: 'identity' } })
  add({ id: 'p-gone', type: 'profile', scope: 'user.ada', title: 'ada', status: 'superseded' })
  // (f) a core key from free properties must not collide with the convention's core profile
  add({ id: 'p-stray', type: 'profile', scope: 'agent.juno', title: 'juno-ops', properties: { core: true } })
  // (h) supersedes / superseded_by: one id or a list; a title, an id prefix or a live target stays
  add({ id: 'd-old', type: 'decision', scope: 'project.p1', title: 'd-old', status: 'superseded',
    properties: { rationale: 'r', alternatives: ['x'], review_note: 'was fine' } })
  add({ id: 'd-new', type: 'decision', scope: 'project.p1', title: 'd-new', properties: { rationale: 'r', alternatives: ['x'], supersedes: 'd-old' } })
  add({ id: 'r-old1', type: 'rule', scope: 'agent.juno', status: 'superseded', properties: { applies: 'always' } })
  add({ id: 'r-old2', type: 'rule', scope: 'agent.juno', status: 'superseded', properties: { applies: 'always' } })
  add({ id: 'r-new', type: 'rule', scope: 'agent.juno', properties: { applies: 'always', supersedes: ['r-old1', 'r-old2'] } })
  add({ id: 'n-sup-title', type: 'note', scope: 'project.p1', properties: { supersedes: ['d-old', 'Some old title'] } })
  add({ id: 'n-sup-live', type: 'note', scope: 'project.p1', properties: { supersedes: 'd-alt' } })
  add({ id: 'ref-old', type: 'reference', scope: 'global', status: 'superseded', properties: { source: 'https://d.example', superseded_by: 'ref-2' } })
  add({ id: 'n-old', type: 'note', scope: 'project.p1', status: 'superseded', properties: { superseded_by: ['n-session', 'n-pane'] } })
  add({ id: 'l-old', type: 'log', scope: 'project.p1', status: 'superseded', properties: { superseded_by: '0f8fad5b' } })
  // (h) status chain in project.p2: a → b → s-1 by created_at; c names its successor itself; p1's lonely one has no successor
  add({ id: 's-old-a', type: 'status', scope: 'project.p2', status: 'superseded', created_at: '2026-09-01 10:00:00', properties: { state: 'v0' } })
  add({ id: 's-old-c', type: 'status', scope: 'project.p2', status: 'superseded', created_at: '2026-09-05 10:00:00', properties: { state: 'v0.5', superseded_by: 's-1' } })
  add({ id: 's-old-b', type: 'status', scope: 'project.p2', status: 'superseded', created_at: '2026-09-10 10:00:00', properties: { state: 'v0.9' } })
  add({ id: 's-lonely', type: 'status', scope: 'project.p1', status: 'superseded', properties: { state: 'old' } })
  // (0) malformed properties: nothing, no JSON, a list, a scalar — on a note and on a task
  add({ id: 'm-empty', type: 'note', scope: 'project.p1', properties: '' })
  add({ id: 'm-invalid', type: 'note', scope: 'project.p1', properties: '{bad' })
  add({ id: 'm-array', type: 'note', scope: 'project.p1', properties: '[1,2]' })
  add({ id: 'm-task-scalar', type: 'task', scope: 'project.p1', title: 'm-task-scalar', properties: '"x"' })
  add({ id: 'm-task-array', type: 'task', scope: 'project.p1', title: 'm-task-array', properties: '[1,2]' })
  // (j) a key date that is no date; a key that spells the review-note entry id
  add({ id: 't-3', type: 'task', scope: 'project.p1', title: 't-3', properties: { 'review-note': 'q', review_note: 'r', progress_2026_02_30: 'x' } })
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
    // source_type agent is gone, decision_type stays readable
    expect(author.properties).toEqual({ rationale: 'r', alternatives: ['x'], review_due_at: '2027-01-01T00:00:00.000Z', detail: 'decision_type: architectural' })
    // a second author is not dropped: it is not the writer
    const kept = engram(db, 'd-author-kept')
    expect(kept.ingested_by).toBe('ada')
    expect(kept.properties).toEqual({ rationale: 'r', alternatives: ['x'], detail: 'source_id: juno-claude-code' })
    expect(engram(db, 'n-two-authors').properties).toEqual({ detail: 'source_id: ada\nsource_type: user' })
    expect(db.prepare(`SELECT id, kind, at, text FROM entries WHERE engram_id = 't-2'`).all())
      .toEqual([{ id: 't-2-prop-source_id', kind: 'change', at: '2026-10-01T10:00:00.000Z', text: 'legacy source: juno' }])
    // <agent>-claude-code is the agent
    const cc = engram(db, 'n-cc')
    expect(cc.ingested_by).toBe('juno')
    expect(cc.properties).toEqual({})
    const seed = engram(db, 'r-seed')
    expect(seed.origin).toBe('eml-default-brain')
    expect(seed.properties).toEqual({ applies: 'always' })
    const pane = engram(db, 'n-pane')
    expect(pane.origin).toBe('cockpit-notes')
    expect(pane.properties).toEqual({ app: { user_content_hash: 'abc123' }, detail: 'source_type: user' })
    const session = engram(db, 'n-session')
    expect(session.origin).toBeNull()
    expect(session.properties).toEqual({ detail: 'hypothesis_type: causal\nsource_id: session-2026-10-01-x' })

    // (d) review_note → review entry on an active rule; boot dropped; a bad rule_type and translated_* to detail
    const rule = engram(db, 'r-review')
    expect(rule.properties).toEqual({ applies: 'always', why: 'w', detail: 'rule_type: guideline\ntranslated_from: de' })
    expect(db.prepare(`SELECT kind, text, at FROM entries WHERE engram_id = 'r-review'`).all())
      .toEqual([{ kind: 'review', text: 'still holds', at: '2026-10-02T10:00:00.000Z' }])
    // (d) on a superseded decision and on a reference it is history, not a review
    expect(engram(db, 'd-old').properties).toEqual({ rationale: 'r', alternatives: ['x'], detail: 'review_note: was fine' })
    expect(db.prepare(`SELECT count(*) AS n FROM entries WHERE kind = 'review' AND engram_id IN ('d-old', 'ref-2')`).get()).toEqual({ n: 0 })

    // (e) renames
    expect(engram(db, 'ref-1').properties).toEqual({ source: 'https://a.example', checked_at: '2026-09-01', detail: 'reference_type: paper\nurl: https://b.example' })
    expect(engram(db, 'ref-2').properties).toEqual({ source: 'https://c.example', checked_at: '2026-09-02', detail: 'review_note: checked' })
    expect(engram(db, 'ev-1').properties).toEqual({ occurred_at: '2026-09-03T00:00:00Z', change_type: 'released', detail: 'renamed_reason: was launch\nvps_ip: 10.0.0.1' })
    expect(engram(db, 'd-alt').properties.alternatives).toEqual(['only one'])

    // (f) core profile; a stray core from free properties is cleared
    expect(engram(db, 'p-core-old').properties).toEqual({ core: true })
    expect(engram(db, 'p-facet').properties).toBeNull()
    expect(engram(db, 'p-user').properties).toEqual({ core: true, detail: 'profile_type: identity' })
    expect(engram(db, 'p-gone').properties).toBeNull()
    expect(engram(db, 'p-stray').properties).toEqual({})

    // (h) supersedes edges from the keys; the key leaves only when every value got its edge
    const edges = (target: string) => db.prepare(
      `SELECT id, source_id, detection_method, strength, explanation, created_at FROM relations WHERE relation = 'supersedes' AND target_id = ? ORDER BY source_id`,
    ).all(target)
    expect(edges('d-old')).toEqual([
      { id: 'd-new-supersedes-d-old', source_id: 'd-new', detection_method: 'agent_declared', strength: 1, explanation: 'v0.19 migration: from properties.supersedes', created_at: STAMP },
      { id: 'n-sup-title-supersedes-d-old', source_id: 'n-sup-title', detection_method: 'agent_declared', strength: 1, explanation: 'v0.19 migration: from properties.supersedes', created_at: STAMP },
    ])
    expect(engram(db, 'd-new').properties).toEqual({ rationale: 'r', alternatives: ['x'] })
    expect(edges('r-old1').map(e => e.source_id)).toEqual(['r-new'])
    expect(edges('r-old2').map(e => e.source_id)).toEqual(['r-new'])
    expect(engram(db, 'r-new').properties).toEqual({ applies: 'always' })
    // a title in the list: the key stays readable
    expect(engram(db, 'n-sup-title').properties).toEqual({ detail: 'supersedes: ["d-old","Some old title"]' })
    // a live target gets no edge
    expect(edges('d-alt')).toEqual([])
    expect(engram(db, 'n-sup-live').properties).toEqual({ detail: 'supersedes: d-alt' })
    // superseded_by: one id or a list, the edge points at the holder
    expect(edges('ref-old')).toEqual([
      { id: 'ref-2-supersedes-ref-old', source_id: 'ref-2', detection_method: 'agent_declared', strength: 1, explanation: 'v0.19 migration: from properties.superseded_by', created_at: STAMP },
    ])
    expect(engram(db, 'ref-old').properties).toEqual({ source: 'https://d.example' })
    expect(edges('n-old').map(e => e.source_id)).toEqual(['n-pane', 'n-session'])
    expect(engram(db, 'n-old').properties).toEqual({})
    // an id prefix names nothing
    expect(edges('l-old')).toEqual([])
    expect(engram(db, 'l-old').properties).toEqual({ detail: 'superseded_by: 0f8fad5b' })
    // (h) status chain: the next newer status in the scope, unless an edge already says otherwise
    expect(edges('s-old-a')).toEqual([
      { id: 's-old-c-supersedes-s-old-a', source_id: 's-old-c', detection_method: 'auto_temporal', strength: 1, explanation: 'v0.19 migration: the next newer status in the scope', created_at: '2026-09-05 10:00:00' },
    ])
    expect(edges('s-old-c').map(e => [e.source_id, e.detection_method])).toEqual([['s-1', 'agent_declared']])
    expect(edges('s-old-b').map(e => [e.source_id, e.detection_method])).toEqual([['s-1', 'auto_temporal']])
    expect(edges('s-lonely')).toEqual([])
    expect(db.prepare(`SELECT count(*) AS n FROM relations WHERE relation = 'supersedes'`).get()).toEqual({ n: 10 })
    // superseded without a successor: only what no key and no chain can resolve
    expect(db.prepare(
      `SELECT id FROM engrams e WHERE status = 'superseded' AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.relation = 'supersedes' AND r.target_id = e.id) ORDER BY id`,
    ).all()).toEqual([{ id: 'l-old' }, { id: 'p-gone' }, { id: 's-lonely' }])

    // (0) malformed properties stay readable
    expect(engram(db, 'm-empty').properties).toBeNull()
    expect(engram(db, 'm-invalid').properties).toEqual({ detail: 'legacy_properties: {bad' })
    expect(engram(db, 'm-array').properties).toEqual({ detail: 'legacy_properties: [1,2]' })
    expect(engram(db, 'm-task-scalar').properties).toEqual({})
    expect(db.prepare(`SELECT id, kind, text FROM entries WHERE engram_id IN ('m-task-scalar', 'm-task-array') ORDER BY id`).all()).toEqual([
      { id: 'm-task-array-prop-legacy_properties', kind: 'note', text: 'legacy_properties: [1,2]' },
      { id: 'm-task-scalar-prop-legacy_properties', kind: 'note', text: 'legacy_properties: "x"' },
    ])

    // (j) task: standard keys stay, the rest is journal
    const task = engram(db, 't-1')
    expect(task.properties).toEqual({ context: 'c', priority: 'high', stage: 'ready', outcome: 'done' })
    expect(db.prepare(`SELECT id, kind, at, author, stage, text FROM entries WHERE engram_id = 't-1' ORDER BY at, rowid`).all()).toEqual([
      // dated from the key
      { id: 't-1-prop-progress_2026_09_23', kind: 'note', at: '2026-09-23T00:00:00.000Z', author: null, stage: 'ready', text: 'progress_2026_09_23: half way' },
      // where the task came from, at its creation
      { id: 't-1-prop-source_id', kind: 'change', at: '2026-10-01T10:00:00.000Z', author: null, stage: 'ready', text: 'legacy source: session-2026-09-20-y' },
      { id: 'e-note', kind: 'note', at: '2026-10-01T11:00:00.000Z', author: 'juno', stage: 'ready', text: 'Started on the plan.' },
      { id: 'e-change', kind: 'change', at: '2026-10-01T12:00:00.000Z', author: 'juno', stage: 'ready', text: 'decision taken: d-author (0f8fad5b-d9cb-469f-a165-70867728950e)' },
      // undated: at the task's last update
      { id: 't-1-prop-resolution', kind: 'note', at: '2026-10-02T10:00:00.000Z', author: null, stage: 'ready', text: 'resolution: shipped it' },
    ])
    // (j) a key date that is no date falls back to updated_at; -prop- ids cannot meet the review-note entry
    expect(db.prepare(`SELECT id, kind, at, text FROM entries WHERE engram_id = 't-3' ORDER BY id`).all()).toEqual([
      { id: 't-3-prop-progress_2026_02_30', kind: 'note', at: '2026-10-02T10:00:00.000Z', text: 'progress_2026_02_30: x' },
      { id: 't-3-prop-review-note', kind: 'note', at: '2026-10-02T10:00:00.000Z', text: 'review-note: q' },
      { id: 't-3-prop-review_note', kind: 'note', at: '2026-10-02T10:00:00.000Z', text: 'review_note: r' },
    ])
    expect(db.prepare(`SELECT count(*) AS n FROM entries WHERE text IS NULL OR text = ''`).get()).toEqual({ n: 0 })

    // (j) other types: lines in key order after the existing detail
    expect(engram(db, 's-1').properties).toEqual({ state: 'v1', next_step: 'n', detail: 'runbook_ref: docs/run.md' })
    expect(engram(db, 'l-1').properties).toEqual({ detail: 'commits: ["a1","b2"]\nmodel: opus-x\ntests_passing: true' })
    expect(engram(db, 'pr-detail').properties).toEqual({ detail: 'first line\nmerged_from: x' })

    // objects: project metadata with every value as text
    expect(db.prepare(`SELECT metadata, status_tracks FROM projects WHERE id = 'p1'`).get())
      .toEqual({ metadata: JSON.stringify({ repo: 'x/y', tags: 'alpha, beta' }), status_tracks: null })
    expect(db.prepare(`SELECT metadata FROM projects WHERE id = 'p2'`).get()).toEqual({ metadata: null })
    expect(JSON.parse((db.prepare(`SELECT metadata FROM projects WHERE id = 'p3'`).get() as { metadata: string }).metadata))
      .toEqual({ infra: '{"host":"h"}', parts: '["a","b"]', n: '3', live: 'true', tags: 'x' })
    expect(db.prepare(`SELECT metadata FROM projects WHERE id = 'p4'`).get()).toEqual({ metadata: JSON.stringify({ legacy: 'not json' }) })
    expect(db.prepare(`SELECT metadata FROM projects WHERE id = 'p5'`).get()).toEqual({ metadata: JSON.stringify({ tags: 'old', project_tags: 'a' }) })
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
      expect(report.outcomes[0]).toMatchObject({ status: 'migrated', kind: 'migrated', appliedVersions: [19, 20] })
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
