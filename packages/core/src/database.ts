import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CURRENT_BRAIN_SCHEMA_VERSION, OLDEST_MIGRATABLE_BRAIN_SCHEMA } from './control'
import { type Clock, systemClock } from './env'

// SQL files ship inside the package, next to src/ and dist/ — the same relative
// location from a workspace checkout and from a bundled build (dist/server.cjs).
const SCHEMA_DIR = join(__dirname, '..', 'migrations', 'brain')

function runSchema(db: Database.Database, file: string): void {
  const sql = readFileSync(join(SCHEMA_DIR, file), 'utf-8')
  db.exec(sql)
}

/**
 * v0.20: the migration ledger row for schema `version`, with `at` as applied_at
 * (the ledger has no clock default since schema 20). Files up to v0.19 write
 * their own row; for those this is a no-op.
 */
export function recordMigration(db: Database.Database, version: number, at: string): void {
  db.prepare('INSERT OR IGNORE INTO _eml_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    .run(version, `${String(version).padStart(3, '0')}_v0.${version}`, at)
}

/**
 * Opens a brain, creating or migrating it to CURRENT_BRAIN_SCHEMA_VERSION.
 *
 * - Fresh file → the complete current schema from `v0.<N>.sql`.
 * - Existing brain at OLDEST_MIGRATABLE_BRAIN_SCHEMA or newer → the
 *   `v0.<N>_migrate.sql` files from its version + 1 up to current, once each.
 *   An already-current brain is a no-op.
 * - Older brain → error; it has to be migrated with an earlier EML release.
 *
 * Each step's ledger row is written here with `clock` as applied_at.
 *
 * The server migrates registered brains eagerly through runForwardMigrations()
 * (backup, preflight, restore on failure); this in-process path keeps the
 * factory (index.ts, provisioning, tests) consistent with it.
 */
export function initDatabase(dbPath: string, clock: Clock = systemClock): Database.Database {
  // This is the CREATE path (fresh provisioning runs the schema below), so it
  // intentionally opens WITHOUT { fileMustExist: true } — unlike the
  // must-exist read/migrate paths (pool.ts, forward-migrations.ts).
  const db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const hasEngrams = !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='engrams'"
  ).get()

  if (!hasEngrams) {
    runSchema(db, `v0.${CURRENT_BRAIN_SCHEMA_VERSION}.sql`)
    recordMigration(db, CURRENT_BRAIN_SCHEMA_VERSION, clock())
    return db
  }

  const hasMigrations = !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='_eml_migrations'"
  ).get()
  const version = hasMigrations
    ? (db.prepare('SELECT MAX(version) as v FROM _eml_migrations').get() as { v: number | null }).v
    : null
  if (version === null || version < OLDEST_MIGRATABLE_BRAIN_SCHEMA) {
    db.close()
    throw new Error(
      `Brain schema ${version ?? 'unknown'} is older than this release can migrate ` +
      `(oldest: ${OLDEST_MIGRATABLE_BRAIN_SCHEMA}). Migrate it with an earlier EML release first.`
    )
  }

  // One file per schema step, each with FKs off: several steps rebuild
  // engrams/relations, and a DROP TABLE engrams with FKs on would cascade-delete
  // the engram_tags / engram_subjects / entries rows (engram_labels up to schema 19).
  for (let v = version + 1; v <= CURRENT_BRAIN_SCHEMA_VERSION; v++) {
    runMigrateWithFkOff(db, `v0.${v}_migrate.sql`)
    recordMigration(db, v, clock())
  }
  return db
}

/**
 * Runs a migration file with foreign_keys OFF (SQLite cannot toggle it inside
 * a transaction), then turns it back ON.
 */
function runMigrateWithFkOff(db: Database.Database, file: string): void {
  db.pragma('foreign_keys = OFF')
  try {
    runSchema(db, file)
  } finally {
    db.pragma('foreign_keys = ON')
  }
}
