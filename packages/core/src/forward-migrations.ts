import path from 'path'
import { readFileSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, writeFileSync, chmodSync } from 'fs'
import Database from 'better-sqlite3'
import type Database_t from 'better-sqlite3'
import { CURRENT_BRAIN_SCHEMA_VERSION, OLDEST_MIGRATABLE_BRAIN_SCHEMA } from './control'
import { applyMigration } from './database'
import { type Clock, systemClock } from './env'
import { brainIdOf } from './log/log'

/**
 * Forward migration runner (v0.9-PROPOSAL §5.8), made safe in v0.14 Cluster 0
 * (decision app-update-flow).
 *
 * Runs at server start, blocking, and migrates every brain whose schema_version
 * is below the target. Forward-only — schema changes must be additive.
 *
 * Migration file convention: <migrationsDir>/v0.<N>_migrate.sql, each applying
 * v0.{N-1} → v0.N. foreign_keys has to be toggled outside a transaction
 * (SQLite limitation), so: FK=OFF → exec(file) → FK=ON.
 *
 * Safety pipeline per brain with pending migrations:
 *   1. backup    VACUUM INTO <backupDir>/pre-migration/… (consistent incl. WAL),
 *                then integrity_check on the copy
 *   2. preflight apply all pending files to a scratch copy of the backup;
 *                integrity_check + no new foreign-key violations
 *   3. migrate   the same files on the live brain
 *   4. restore   if 3 fails: copy the backup back, drop -wal/-shm, verify
 * Every attempt writes a JSON report to <reportsDir> (read by the cockpit banner).
 *
 * Brain status after a failure:
 *   - backup_failed / preflight_failed / restored: the brain stays status='ok'
 *     on its OLD schema_version. The routing middleware refuses it while the
 *     code is newer (503 BRAIN_BEHIND_CODE); the previous app version still
 *     serves it; the next start retries (safe, it begins with a preflight).
 *   - brain_missing / restore_failed: status='needs_intervention' — the only
 *     cases that need a human.
 *
 * Tracking per brain (two records, by design): the runner writes the brain's
 * _eml_migrations row with each file, in its transaction from v0.20 on
 * (database.ts applyMigration; files up to v0.19 also write their own),
 * and brain_migrations + brains.schema_version in control after success.
 */

export type MigrationOutcomeKind =
  | 'migrated'
  | 'brain_missing'
  | 'backup_failed'
  | 'preflight_failed'
  | 'restored'
  | 'restore_failed'

export interface BrainMigrationOutcome {
  brainId: string
  brainName: string
  fromVersion: number
  toVersion: number
  appliedVersions: number[]
  status: 'migrated' | 'skipped' | 'failed'
  /** Set whenever a migration was attempted (status migrated or failed). */
  kind?: MigrationOutcomeKind
  error?: string
  /** Pre-migration backup of the brain (kept on every outcome except backup_failed). */
  backupPath?: string
  reportPath?: string
}

export interface ForwardMigrationsReport {
  totalBrains: number
  migratedCount: number
  skippedCount: number
  failedCount: number
  outcomes: BrainMigrationOutcome[]
}

/** The JSON written to <reportsDir> for every attempted migration. */
export interface MigrationReport {
  brainId: string
  brainName: string
  from: number
  to: number
  outcome: MigrationOutcomeKind
  error?: string
  backupPath?: string
  codeVersion?: string
  at: string
}

/** The four pipeline steps — injectable so tests can fail one on purpose. */
export interface MigrationSteps {
  backup(brainPath: string, backupPath: string): void
  /** `at`: applied_at of the ledger rows the files get; `brain`: the id a genesis written on the way names (control.db's). */
  preflight(backupPath: string, scratchPath: string, files: MigrationFile[], at: string, brain: string): void
  applyLive(brainPath: string, files: MigrationFile[], at: string, brain: string): void
  restore(backupPath: string, brainPath: string): void
}

export interface MigrationFile {
  version: number
  sql: string
}

export interface RunForwardMigrationsOptions {
  control: Database_t.Database
  dataDir: string
  migrationsDir?: string
  targetVersion?: number
  /** Default <dataDir>/backups. Pre-migration backups go to <backupDir>/pre-migration. */
  backupDir?: string
  /** Default <dataDir>/migration-reports. */
  reportsDir?: string
  /** Pre-migration backups kept per brain after a successful migration. Default 3. */
  keepBackups?: number
  /** Version of the running code, recorded in the report. */
  codeVersion?: string
  /** applied_at of the brain's ledger rows. Default the system clock. */
  clock?: Clock
  /** Called with one line per brain before it is migrated (e.g. for a log). */
  onProgress?: (line: string) => void
  /** @internal tests only — replace pipeline steps. */
  steps?: Partial<MigrationSteps>
}

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations', 'brain')
const DEFAULT_KEEP_BACKUPS = 3

export function runForwardMigrations(opts: RunForwardMigrationsOptions): ForwardMigrationsReport {
  const targetVersion = opts.targetVersion ?? CURRENT_BRAIN_SCHEMA_VERSION
  const migrationsDir = opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR

  const candidates = opts.control.prepare(
    `SELECT id, name, brain_file, schema_version, status FROM brains ORDER BY created_at ASC`,
  ).all() as Array<{
    id: string, name: string, brain_file: string, schema_version: number, status: string,
  }>

  const outcomes: BrainMigrationOutcome[] = []

  for (const brain of candidates) {
    if (brain.status !== 'ok') {
      outcomes.push({
        brainId: brain.id,
        brainName: brain.name,
        fromVersion: brain.schema_version,
        toVersion: brain.schema_version,
        appliedVersions: [],
        status: 'skipped',
        error: `brain status = ${brain.status} (not migrating)`,
      })
      continue
    }
    if (brain.schema_version >= targetVersion) {
      outcomes.push({
        brainId: brain.id,
        brainName: brain.name,
        fromVersion: brain.schema_version,
        toVersion: brain.schema_version,
        appliedVersions: [],
        status: 'skipped',
      })
      continue
    }

    opts.onProgress?.(`migrating ${brain.name} v${brain.schema_version}→v${targetVersion}`)
    const outcome = migrateOne({ ...opts, migrationsDir, brain, targetVersion })
    outcome.reportPath = writeReport(opts, outcome)
    outcomes.push(outcome)
  }

  return {
    totalBrains: outcomes.length,
    migratedCount: outcomes.filter(o => o.status === 'migrated').length,
    skippedCount: outcomes.filter(o => o.status === 'skipped').length,
    failedCount: outcomes.filter(o => o.status === 'failed').length,
    outcomes,
  }
}

function migrateOne(args: RunForwardMigrationsOptions & {
  migrationsDir: string
  brain: { id: string, name: string, brain_file: string, schema_version: number }
  targetVersion: number
}): BrainMigrationOutcome {
  const { control, dataDir, migrationsDir, brain, targetVersion } = args
  const steps: MigrationSteps = { ...DEFAULT_STEPS, ...args.steps }
  const fromVersion = brain.schema_version
  const brainPath = path.isAbsolute(brain.brain_file)
    ? brain.brain_file
    : path.join(dataDir, brain.brain_file)

  const base = {
    brainId: brain.id,
    brainName: brain.name,
    fromVersion,
    toVersion: fromVersion,
    appliedVersions: [] as number[],
  }
  const fail = (kind: MigrationOutcomeKind, err: unknown, backupPath?: string): BrainMigrationOutcome => {
    if (kind === 'brain_missing' || kind === 'restore_failed') {
      control.prepare(
        `UPDATE brains SET status = 'needs_intervention', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(brain.id)
    }
    return { ...base, status: 'failed', kind, error: errorText(err), backupPath }
  }

  // v0.10.10 C3: a registered brain must exist on disk — never create and
  // "migrate" an empty schemaless DB in its place.
  if (!existsSync(brainPath)) {
    return fail('brain_missing', new Error(`brain data file missing: ${brainPath}`))
  }

  // Missing or unreadable migration files are a packaging error: nothing has
  // been touched yet, so they count as a failed preflight.
  let files: MigrationFile[]
  try {
    files = readMigrationFiles(migrationsDir, fromVersion, targetVersion)
  } catch (err) {
    return fail('preflight_failed', err)
  }

  const preDir = path.join(args.backupDir ?? path.join(dataDir, 'backups'), 'pre-migration')
  const backupPath = path.join(preDir, `${brain.id}-${stamp()}-v${fromVersion}.db`)
  try {
    mkdirSync(preDir, { recursive: true, mode: 0o700 })
    steps.backup(brainPath, backupPath)
  } catch (err) {
    rmSync(backupPath, { force: true })
    return fail('backup_failed', err)
  }

  const at = (args.clock ?? systemClock)()
  const scratchPath = `${backupPath}.preflight`
  try {
    steps.preflight(backupPath, scratchPath, files, at, brain.id)
  } catch (err) {
    return fail('preflight_failed', err, backupPath)
  } finally {
    removeDbFiles(scratchPath)
  }

  try {
    steps.applyLive(brainPath, files, at, brain.id)
  } catch (liveErr) {
    try {
      steps.restore(backupPath, brainPath)
    } catch (restoreErr) {
      return fail('restore_failed',
        new Error(`${errorText(liveErr)}; restore failed: ${errorText(restoreErr)}`), backupPath)
    }
    return fail('restored', liveErr, backupPath)
  }

  const applied = files.map(f => f.version)
  control.transaction(() => {
    for (const v of applied) {
      control.prepare(
        `INSERT INTO brain_migrations (brain_id, schema_version) VALUES (?, ?)
         ON CONFLICT(brain_id, schema_version) DO NOTHING`,
      ).run(brain.id, v)
    }
    control.prepare(
      `UPDATE brains SET schema_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(targetVersion, brain.id)
  })()

  pruneBackups(preDir, brain.id, args.keepBackups ?? DEFAULT_KEEP_BACKUPS)

  return {
    ...base,
    toVersion: targetVersion,
    appliedVersions: applied,
    status: 'migrated',
    kind: 'migrated',
    backupPath,
  }
}

// --- Pipeline steps -----------------------------------------------------

const DEFAULT_STEPS: MigrationSteps = {
  backup(brainPath, backupPath) {
    withDb(brainPath, db => backupBrain(db, backupPath))
  },

  preflight(backupPath, scratchPath, files, at, brain) {
    copyFileSync(backupPath, scratchPath)
    withDb(scratchPath, db => {
      const fkBefore = foreignKeyViolations(db)
      applyFiles(db, files, at, brain)
      assertIntegrity(db, 'preflight')
      const fkAfter = foreignKeyViolations(db)
      if (fkAfter > fkBefore) {
        throw new Error(`preflight: migration adds ${fkAfter - fkBefore} foreign-key violation(s)`)
      }
    })
  },

  applyLive(brainPath, files, at, brain) {
    withDb(brainPath, db => applyFiles(db, files, at, brain))
  },

  restore(backupPath, brainPath) {
    copyFileSync(backupPath, brainPath)
    rmSync(`${brainPath}-wal`, { force: true })
    rmSync(`${brainPath}-shm`, { force: true })
    withDb(brainPath, db => assertIntegrity(db, 'restore'))
  },
}

/** A registered brain whose genesis names another id than its control row. */
export interface BrainIdMismatch {
  brainId: string
  brainName: string
  genesisId: string | null
}

/**
 * v0.21: a brain carries its id in its genesis; control.db's brains.id is a
 * cache of it. Checks every brain with status ok that has a genesis and sets
 * a mismatch to needs_intervention — routing then refuses it, as it does a
 * failed migration. A brain without a log yet (an older schema) or without
 * its file is left to the migration and routing checks.
 */
export function checkBrainIds(opts: { control: Database_t.Database, dataDir: string }): BrainIdMismatch[] {
  const brains = opts.control.prepare(`SELECT id, name, brain_file FROM brains WHERE status = 'ok' ORDER BY created_at ASC`)
    .all() as Array<{ id: string, name: string, brain_file: string }>
  const mismatches: BrainIdMismatch[] = []
  for (const brain of brains) {
    const file = path.isAbsolute(brain.brain_file) ? brain.brain_file : path.join(opts.dataDir, brain.brain_file)
    if (!existsSync(file)) continue
    const db = new Database(file, { readonly: true, fileMustExist: true })
    let genesisId: string | null | undefined
    try {
      const hasLog = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'op_log'`).get()
      genesisId = hasLog && db.prepare('SELECT 1 FROM op_log WHERE seq = 1').get() ? brainIdOf(db) : undefined
    } finally {
      db.close()
    }
    if (genesisId === undefined || genesisId === brain.id) continue
    opts.control.prepare(`UPDATE brains SET status = 'needs_intervention', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(brain.id)
    mismatches.push({ brainId: brain.id, brainName: brain.name, genesisId })
  }
  return mismatches
}

/**
 * A copy of the open brain `db` at `backupPath`: VACUUM INTO (consistent incl.
 * WAL; refuses an existing file), owner-only, integrity-checked. The
 * pre-migration backup and the source backup of a cross-brain move.
 */
export function backupBrain(db: Database_t.Database, backupPath: string): void {
  db.prepare('VACUUM INTO ?').run(backupPath)
  chmodSync(backupPath, 0o600)
  withDb(backupPath, db => assertIntegrity(db, 'backup'))
}

function applyFiles(db: Database_t.Database, files: MigrationFile[], at: string, brain: string): void {
  db.pragma('foreign_keys = OFF')
  try {
    for (const f of files) {
      try {
        applyMigration(db, f.version, f.sql, () => at, brain)
      } catch (err) {
        throw new Error(`v0.${f.version}_migrate.sql: ${errorText(err)}`)
      }
    }
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

function withDb(file: string, fn: (db: Database_t.Database) => void): void {
  const db = new Database(file, { fileMustExist: true })
  try {
    fn(db)
  } finally {
    db.close()
  }
}

function assertIntegrity(db: Database_t.Database, step: string): void {
  const result = db.pragma('integrity_check', { simple: true })
  if (result !== 'ok') throw new Error(`${step}: integrity_check failed: ${String(result)}`)
}

function foreignKeyViolations(db: Database_t.Database): number {
  return (db.pragma('foreign_key_check') as unknown[]).length
}

// --- Files, reports, retention ------------------------------------------

function readMigrationFiles(dir: string, from: number, to: number): MigrationFile[] {
  if (from < OLDEST_MIGRATABLE_BRAIN_SCHEMA) {
    throw new Error(
      `brain schema ${from} is older than this release can migrate (oldest: ${OLDEST_MIGRATABLE_BRAIN_SCHEMA}) — ` +
      `migrate it with an earlier EML release first`,
    )
  }
  const files: MigrationFile[] = []
  for (let v = from + 1; v <= to; v++) {
    const file = path.join(dir, `v0.${v}_migrate.sql`)
    if (!existsSync(file)) {
      throw new Error(`migration file not found: v0.${v}_migrate.sql (${file})`)
    }
    files.push({ version: v, sql: readFileSync(file, 'utf-8') })
  }
  return files
}

function writeReport(opts: RunForwardMigrationsOptions, o: BrainMigrationOutcome): string | undefined {
  const dir = opts.reportsDir ?? path.join(opts.dataDir, 'migration-reports')
  const report: MigrationReport = {
    brainId: o.brainId,
    brainName: o.brainName,
    from: o.fromVersion,
    to: opts.targetVersion ?? CURRENT_BRAIN_SCHEMA_VERSION,
    outcome: o.kind!,
    error: o.error,
    backupPath: o.backupPath,
    codeVersion: opts.codeVersion,
    at: new Date().toISOString(),
  }
  const file = path.join(dir, `${stamp()}-${o.brainId.slice(0, 8)}.json`)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    return file
  } catch {
    // A report that can't be written must not block the start; the outcome
    // still reaches the server log.
    return undefined
  }
}

function pruneBackups(dir: string, brainId: string, keep: number): void {
  const mine = readdirSync(dir)
    .filter(name => name.startsWith(`${brainId}-`) && name.endsWith('.db'))
    .sort()
    .reverse()
  for (const name of mine.slice(keep)) removeDbFiles(path.join(dir, name))
}

function removeDbFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true })
}

/** Sortable, filename-safe UTC timestamp with milliseconds. */
function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('.', '')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
