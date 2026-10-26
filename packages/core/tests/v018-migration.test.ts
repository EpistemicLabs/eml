import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { initControlDatabase } from '../src/control'
import { runForwardMigrations } from '../src/forward-migrations'
import { seedDefaultBrain } from '../src/default-brain'

// v0.18 — no table change; the engram model gets the short rule/profile format.
// v0.18_migrate.sql rewrites the three default-brain agent rules that still carry
// their seed text exactly (the one text version shipped since v0.17.11, kept in
// fixtures/default-brain-rules-v0.17.json) into the short seeds of
// default-brain.ts. Anything the user changed stays as it is.

const MIGRATIONS = join(__dirname, '..', 'migrations', 'brain')
const V12_FIXTURE = join(__dirname, 'fixtures', 'brain-v12.sql')
const OLD_SEED_RULES = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'default-brain-rules-v0.17.json'), 'utf-8'),
) as Array<{ title: string, content: string, properties: Record<string, unknown> }>

const AGENT = 'juno'
const DUE = '2027-01-01T00:00:00.000Z'
const OLD_STAMP = '2026-10-02 10:00:00'
// schema 20 rewrites every timestamp to ISO-8601 UTC ms
const OLD_STAMP_ISO = '2026-10-02T10:00:00.000Z'
const sub = (s: string) => s.replace(/<agent>/g, AGENT)

/**
 * A brain as v0.17 left it: the three seed rules as seeded, and seed-titled
 * rows the migration must leave alone — content edited (c-1), no seed marker
 * (u-1), a why, detail or trigger of the user's own (w-1, d-1, t-1), no longer
 * active (i-1).
 */
function createV17Brain(file: string): void {
  const db = new Database(file)
  db.exec(readFileSync(V12_FIXTURE, 'utf-8'))
  db.exec(readFileSync(join(MIGRATIONS, 'v0.13_migrate.sql'), 'utf-8'))
  db.pragma('foreign_keys = OFF')
  for (const v of [14, 15, 16, 17]) db.exec(readFileSync(join(MIGRATIONS, `v0.${v}_migrate.sql`), 'utf-8'))
  db.pragma('foreign_keys = ON')

  const engram = db.prepare(
    `INSERT INTO engrams (id, type, scope, title, content, properties, status, created_at, updated_at)
     VALUES (?, 'rule', ?, ?, ?, ?, ?, '2026-10-01 10:00:00', '${OLD_STAMP}')`,
  )
  const fts = db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) VALUES (?, ?, ?, ?)`)
  const add = (id: string, title: string, content: string, properties: Record<string, unknown>, status = 'active') => {
    const scope = `agent.${AGENT}`
    engram.run(id, scope, title, content, JSON.stringify(properties), status)
    fts.run(id, content, scope, title)
  }
  const seedProps = (p: Record<string, unknown>) => ({
    ...p,
    boot: (p.boot as string[]).map(sub),
    review_due_at: DUE,
  })
  OLD_SEED_RULES.forEach((r, i) => add(`s-${i + 1}`, sub(r.title), r.content, seedProps(r.properties)))
  const first = OLD_SEED_RULES[0]
  const title = sub(first.title)
  add('c-1', title, `${first.content} Always.`, seedProps(first.properties))
  const { source_id: _s, source_type: _t, ...unmarked } = seedProps(first.properties)
  add('u-1', title, first.content, unmarked)
  add('w-1', title, first.content, { ...seedProps(first.properties), why: 'my own reason' })
  add('d-1', title, first.content, { ...seedProps(first.properties), detail: 'my own detail' })
  add('t-1', title, first.content, { ...seedProps(first.properties), trigger: 'my own trigger' })
  add('i-1', title, first.content, seedProps(first.properties), 'superseded')
  db.close()
}

/** The short seed rules a fresh brain gets today, by title. */
function currentSeedRules(dir: string): Record<string, { content: string, properties: Record<string, unknown> }> {
  const file = join(dir, 'seed.db')
  seedDefaultBrain(file, AGENT)
  const eml = new EML({ namespace: AGENT, dbPath: file })
  try {
    return Object.fromEntries(
      eml.engrams.query({ type: 'rule' }).map((e) => {
        const { review_due_at: _due, ...properties } = (e.properties ?? {}) as Record<string, unknown>
        return [e.title, { content: e.content, properties }]
      }),
    )
  } finally { eml.close() }
}

function rows(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    return Object.fromEntries(
      (db.prepare('SELECT id, title, content, properties, updated_at FROM engrams ORDER BY id').all() as Array<Record<string, string>>)
        .map((r) => [r.id, { ...r, properties: JSON.parse(r.properties) }]),
    )
  } finally { db.close() }
}

function expectMigrated(file: string, dir: string): void {
  const seeds = currentSeedRules(dir)
  const after = rows(file)
  OLD_SEED_RULES.forEach((r, i) => {
    const row = after[`s-${i + 1}`]
    const seed = seeds[sub(r.title)]
    expect(row.content).toBe(seed.content)
    // v0.19 moves the seed marker from properties.source_id to the origin column;
    // agreed is new on the v0.19 seeds (an existing rule keeps what it had).
    const { source_id: _s, source_type: _t, agreed: _a, ...seedFields } = seed.properties
    expect(row.properties).toEqual({ ...seedFields, review_due_at: DUE })
    expect(row.properties.boot).toBeUndefined()
    expect(row.updated_at).not.toBe(OLD_STAMP_ISO)
  })
  // Edited, unmarked, with a why of its own, or inactive: untouched.
  expect(after['c-1'].content).toBe(`${OLD_SEED_RULES[0].content} Always.`)
  // (v0.19 then drops properties.boot everywhere; the edit itself stays.)
  expect(after['c-1'].properties.boot).toBeUndefined()
  for (const id of ['u-1', 'w-1', 'd-1', 't-1', 'i-1']) expect(after[id].content).toBe(OLD_SEED_RULES[0].content)
  expect(after['w-1'].properties.why).toBe('my own reason')
  for (const id of ['c-1', 'u-1', 'w-1', 'd-1', 't-1', 'i-1']) expect(after[id].updated_at).toBe(OLD_STAMP_ISO)

  const db = new Database(file, { readonly: true })
  try {
    // Search sees the new text of the rewritten rows, and only it.
    const fts = db.prepare('SELECT content FROM engrams_fts WHERE id = ?')
    OLD_SEED_RULES.forEach((r, i) => {
      expect(fts.all(`s-${i + 1}`)).toEqual([{ content: seeds[sub(r.title)].content }])
    })
    expect((db.prepare('SELECT count(*) AS n FROM engrams_fts').get() as { n: number }).n).toBe(9)
    expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
    expect(db.prepare(`SELECT name FROM sqlite_temp_master WHERE name = 'seed_rules_v018'`).get()).toBeUndefined()
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  } finally { db.close() }
}

describe('v0.18 migration — unchanged default-brain seed rules become the short seeds', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-v018-mig-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('the current brain schema is 18 or later', () => {
    expect(CURRENT_BRAIN_SCHEMA_VERSION).toBeGreaterThanOrEqual(18)
  })

  it('the fixture holds the three seed rules, all over the new limit', () => {
    expect(OLD_SEED_RULES.map((r) => r.title)).toEqual([
      '<agent>-reasoning-discipline', '<agent>-engagement-style', '<agent>-action-protocol',
    ])
    for (const r of OLD_SEED_RULES) expect(r.content.length).toBeGreaterThan(200)
  })

  it('through the forward-migration pipeline', () => {
    const dataDir = join(dir, 'data')
    mkdirSync(join(dataDir, 'brains'), { recursive: true })
    const brainFile = join(dataDir, 'brains', 'b1.db')
    createV17Brain(brainFile)

    const control = initControlDatabase(':memory:')
    try {
      control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'a@b.de')`).run()
      control.prepare(
        `INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES ('b1', 'test', 'u1', 'brains/b1.db', 17)`,
      ).run()
      const report = runForwardMigrations({ control, dataDir })
      expect(report.outcomes[0]).toMatchObject({ status: 'migrated', kind: 'migrated', appliedVersions: [18, 19, 20, 21] })
    } finally { control.close() }

    expectMigrated(brainFile, dir)
  })

  it('through initDatabase (in-process path): same result', () => {
    const brainFile = join(dir, 'v17.db')
    createV17Brain(brainFile)
    new EML({ namespace: 'test', dbPath: brainFile }).close()
    expectMigrated(brainFile, dir)
  })
})
