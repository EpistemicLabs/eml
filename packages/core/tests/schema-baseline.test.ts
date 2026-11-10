import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION, OLDEST_MIGRATABLE_BRAIN_SCHEMA } from '../src'

// A fresh brain is created from one file (v0.<N>.sql); an existing brain reaches
// the same schema through the v0.<N>_migrate.sql chain. These tests keep the two
// paths identical: same tables, columns, CHECKs, indexes and seed rows.

const MIGRATIONS = join(__dirname, '..', 'migrations', 'brain')
const V12_FIXTURE = join(__dirname, 'fixtures', 'brain-v12.sql')

/** The schema as comparable text: every object's SQL, comments and whitespace stripped. */
function schemaOf(file: string): Array<{ type: string, name: string, sql: string | null }> {
  const db = new Database(file, { readonly: true })
  try {
    const rows = db.prepare(
      `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'engrams_fts_%' ORDER BY type, name`,
    ).all() as Array<{ type: string, name: string, sql: string | null }>
    return rows.map(r => ({ ...r, sql: r.sql === null ? null : normalize(r.sql) }))
  } finally { db.close() }
}

function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')        // line comments
    .replace(/"(\w+)"/g, '$1')       // ALTER TABLE … RENAME quotes the new name
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()
}

/**
 * Seed rows, without timestamps (the migration ledger differs by design). v0.20: the labels seed is gone with its table.
 * v0.21: both paths start the op log with one genesis entry (its hash covers the brain's state and time, so it differs).
 */
function seedOf(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    return {
      version: (db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v,
      log: db.prepare(`SELECT seq, json_extract(payload, '$.call') AS call FROM op_log ORDER BY seq`).all(),
      snapshots: db.prepare('SELECT seq, schema FROM op_snapshots ORDER BY seq').all(),
    }
  } finally { db.close() }
}

function brainFromV12(file: string): void {
  const db = new Database(file)
  db.exec(readFileSync(V12_FIXTURE, 'utf-8'))
  db.close()
}

describe('brain schema baseline', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-baseline-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it(`ships v0.${CURRENT_BRAIN_SCHEMA_VERSION}.sql and every migrate file from v0.${OLDEST_MIGRATABLE_BRAIN_SCHEMA + 1} on`, () => {
    expect(existsSync(join(MIGRATIONS, `v0.${CURRENT_BRAIN_SCHEMA_VERSION}.sql`))).toBe(true)
    for (let v = OLDEST_MIGRATABLE_BRAIN_SCHEMA + 1; v <= CURRENT_BRAIN_SCHEMA_VERSION; v++) {
      expect(existsSync(join(MIGRATIONS, `v0.${v}_migrate.sql`)), `v0.${v}_migrate.sql`).toBe(true)
    }
  })

  it('a fresh brain and a migrated v12 brain end in the identical schema and seed', () => {
    const fresh = join(dir, 'fresh.db')
    new EML({ namespace: 'test', dbPath: fresh }).close()

    const migrated = join(dir, 'migrated.db')
    brainFromV12(migrated)
    new EML({ namespace: 'test', dbPath: migrated }).close()

    expect(schemaOf(migrated)).toEqual(schemaOf(fresh))
    expect(seedOf(migrated)).toEqual(seedOf(fresh))
    expect(seedOf(fresh).version).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
    expect(seedOf(fresh).log).toEqual([{ seq: 1, call: 'brain.genesis' }])
    expect(seedOf(fresh).snapshots).toEqual([{ seq: 1, schema: CURRENT_BRAIN_SCHEMA_VERSION }])
  })

  it('refuses a brain older than the oldest migratable schema, without touching it', () => {
    const old = join(dir, 'old.db')
    brainFromV12(old)
    const db = new Database(old)
    db.exec(`DELETE FROM _eml_migrations; INSERT INTO _eml_migrations (version, name) VALUES (${OLDEST_MIGRATABLE_BRAIN_SCHEMA - 1}, 'old')`)
    db.close()
    const before = schemaOf(old)
    expect(() => new EML({ namespace: 'test', dbPath: old })).toThrow(/older than this release can migrate/)
    expect(schemaOf(old)).toEqual(before)
  })
})
