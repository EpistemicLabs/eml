import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Control-Plane Database Layer.
 *
 * Lives at <data-dir>/control.db, separate from brain files
 * (<data-dir>/brains/<uuid>.db). Holds the state for token → user → brain
 * routing — see v0.9-cluster-a-explained.md §1.
 *
 * Symmetric to database.ts (brain side): schema init from migrations/control/,
 * forward-only migrations tracked in meta_migrations.
 */

const CONTROL_MIGRATIONS_DIR = join(__dirname, '..', 'migrations', 'control')

/**
 * Current control-plane schema version. Bumped when migrations/control/
 * gets a new vX.Y.sql (e.g. pre-release: additive BetterAuth tables).
 */
export const CURRENT_CONTROL_SCHEMA_VERSION = 1

/**
 * Brain DB schema version. A fresh brain is created from
 * migrations/brain/v0.<N>.sql; existing brains migrate through the
 * v0.<N>_migrate.sql files (database.ts, forward-migrations.ts).
 * v0.13: labels + engram_labels (workflow/role facet; `review` staleness flag);
 *   unused since v0.20 (review_due is computed at read time).
 * v0.14: engrams rebuilt for the `note` type (type CHECK); Cluster B adds subjects.
 * v0.15: relations rebuilt for the `part_of` verb (relation CHECK); task_entries.
 * v0.16: epistemic mode removed — engrams rebuilt without `mode` and the five
 *   epistemic types (old rows become notes), relations without `evaluates`.
 * v0.18: no table change — the engram model changes (short rule/profile format,
 *   trigger for situational rules); unchanged default-brain seed rules are rewritten.
 * v0.19: the tool surface rework — engrams rebuilt for the `learning` type and
 *   the provenance columns origin / model / harness; task_entries → entries
 *   (journal, evidence, review); tag / entity status, status_tracks; free
 *   properties folded into the typed fields.
 * v0.20: the sync-ready write path — engrams.rev (revision counter).
 * The brain migration runner (Phase A.5) brings brain files up to it.
 */
export const CURRENT_BRAIN_SCHEMA_VERSION = 20

/**
 * The oldest brain schema this release can migrate forward: brains at 12 or
 * newer run the vX.Y_migrate.sql files from 13 up to CURRENT_BRAIN_SCHEMA_VERSION.
 * Older brains have to be brought to 12 with an earlier EML release first.
 */
export const OLDEST_MIGRATABLE_BRAIN_SCHEMA = 12

export function initControlDatabase(controlPath: string): Database.Database {
  const db = new Database(controlPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const hasMetaMigrations = !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='meta_migrations'"
  ).get()

  if (!hasMetaMigrations) {
    // Fresh DB — apply v0.9 initial schema
    runMigration(db, 'v0.9.sql')
    db.prepare('INSERT INTO meta_migrations (schema_version) VALUES (?)').run(1)
    return db
  }

  // Existing DB — chain pending migrations forward.
  // (v0.9 is the initial version, so no-op. Pre-release will chain v0.10/v0.11 etc. here.)
  const currentVersion = (db.prepare(
    'SELECT MAX(schema_version) as v FROM meta_migrations'
  ).get() as { v: number | null }).v ?? 0

  if (currentVersion < CURRENT_CONTROL_SCHEMA_VERSION) {
    throw new Error(
      `Control-Plane schema_version=${currentVersion} < required ${CURRENT_CONTROL_SCHEMA_VERSION}. ` +
      `Forward-migrations between these versions not yet implemented (v0.9 is initial).`
    )
  }

  return db
}

function runMigration(db: Database.Database, file: string): void {
  const sql = readFileSync(join(CONTROL_MIGRATIONS_DIR, file), 'utf-8')
  db.exec(sql)
}
