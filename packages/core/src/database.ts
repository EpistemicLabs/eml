import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CURRENT_BRAIN_SCHEMA_VERSION, OLDEST_MIGRATABLE_BRAIN_SCHEMA } from './control'
import { type Clock, systemClock } from './env'
import { needsGenesis, writeGenesis } from './log/log'

// SQL files ship inside the package, next to src/ and dist/ — the same relative
// location from a workspace checkout and from a bundled build (dist/server.cjs).
const SCHEMA_DIR = join(__dirname, '..', 'migrations', 'brain')

function readSchema(file: string): string {
  return readFileSync(join(SCHEMA_DIR, file), 'utf-8')
}

/**
 * v0.20: the migration ledger row for schema `version`, with `at` as applied_at
 * (the ledger has no clock default since schema 20). Files up to v0.19 write
 * their own row; for those this is a no-op.
 */
function recordMigration(db: Database.Database, version: number, at: string): void {
  db.prepare('INSERT OR IGNORE INTO _eml_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    .run(version, `${String(version).padStart(3, '0')}_v0.${version}`, at)
}

/** From this schema on, a migrate file has no BEGIN/COMMIT of its own: the runner owns the transaction. */
const RUNNER_TRANSACTION_FROM = 20

/**
 * Applies one schema file (a migrate step, or the fresh schema) and its ledger
 * row. From v0.20 on both commit in one transaction — a crash leaves the brain
 * at the old schema or the new one with its row, never in between; files up to
 * v0.19 carry their own BEGIN/COMMIT and run as they are. `at` is read inside
 * the transaction. foreign_keys is the caller's (it cannot change in a transaction).
 *
 * v0.21: a step that leaves the brain with an empty op log (schema 21 reached,
 * fresh or migrated) writes the log's genesis in the same transaction.
 */
export function applyMigration(db: Database.Database, version: number, sql: string, at: () => string): void {
  if (version >= RUNNER_TRANSACTION_FROM) {
    db.transaction(() => {
      db.exec(sql)
      const now = at()
      recordMigration(db, version, now)
      if (needsGenesis(db)) writeGenesis(db, version, now)
    })()
  } else {
    db.exec(sql)
    recordMigration(db, version, at())
  }
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
 * Each step's ledger row is written here with `clock` as applied_at, in the
 * step's transaction (applyMigration).
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
  try {
    return createOrMigrate(db, clock)
  } catch (err) {
    // a failed create or migration must not keep the file open (on Windows the
    // open handle locks it until the process exits)
    if (db.open) db.close()
    throw err
  }
}

function createOrMigrate(db: Database.Database, clock: Clock): Database.Database {
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const hasEngrams = !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='engrams'"
  ).get()

  if (!hasEngrams) {
    applyMigration(db, CURRENT_BRAIN_SCHEMA_VERSION, readSchema(`v0.${CURRENT_BRAIN_SCHEMA_VERSION}.sql`), clock)
    return db
  }

  const hasMigrations = !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='_eml_migrations'"
  ).get()
  const version = hasMigrations
    ? (db.prepare('SELECT MAX(version) as v FROM _eml_migrations').get() as { v: number | null }).v
    : null
  if (version === null || version < OLDEST_MIGRATABLE_BRAIN_SCHEMA) {
    throw new Error(
      `Brain schema ${version ?? 'unknown'} is older than this release can migrate ` +
      `(oldest: ${OLDEST_MIGRATABLE_BRAIN_SCHEMA}). Migrate it with an earlier EML release first.`
    )
  }

  // One file per schema step, each with FKs off: several steps rebuild
  // engrams/relations, and a DROP TABLE engrams with FKs on would cascade-delete
  // the engram_tags / engram_subjects / entries rows (engram_labels up to schema 19).
  for (let v = version + 1; v <= CURRENT_BRAIN_SCHEMA_VERSION; v++) {
    runMigrateWithFkOff(db, v, clock)
  }
  return db
}

/**
 * Runs migration step `version` with foreign_keys OFF (SQLite cannot toggle it
 * inside a transaction), then turns it back ON.
 */
function runMigrateWithFkOff(db: Database.Database, version: number, clock: Clock): void {
  db.pragma('foreign_keys = OFF')
  try {
    applyMigration(db, version, readSchema(`v0.${version}_migrate.sql`), clock)
  } finally {
    db.pragma('foreign_keys = ON')
  }
}
