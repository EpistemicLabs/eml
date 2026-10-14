import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import type Database_t from 'better-sqlite3'
import { initControlDatabase, CURRENT_BRAIN_SCHEMA_VERSION } from '../src/control'
import { provisionUser } from '../src/provisioning'
import { runForwardMigrations } from '../src/forward-migrations'

describe('runForwardMigrations', () => {
  // Tests are relative to the current schema version: provisioned brains start at
  // CURRENT, and synthetic future migrations target CURRENT+1 / CURRENT+2 so the
  // suite survives every schema bump without hardcoded version numbers.
  const V = CURRENT_BRAIN_SCHEMA_VERSION
  const N1 = V + 1
  const N2 = V + 2

  let control: Database_t.Database
  let dataDir: string
  let migrationsDir: string

  beforeEach(() => {
    control = initControlDatabase(':memory:')
    dataDir = mkdtempSync(join(tmpdir(), 'eml-fm-test-'))
    migrationsDir = mkdtempSync(join(tmpdir(), 'eml-fm-migrations-'))
  })

  afterEach(() => {
    control.close()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(migrationsDir, { recursive: true, force: true })
  })

  describe('happy path', () => {
    it('reports skipped when no brains exist', () => {
      const report = runForwardMigrations({ control, dataDir, migrationsDir })
      expect(report).toEqual({
        totalBrains: 0,
        migratedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        outcomes: [],
      })
    })

    it('skipped when brain already at target version', () => {
      provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      const report = runForwardMigrations({ control, dataDir, migrationsDir })
      expect(report.totalBrains).toBe(1)
      expect(report.skippedCount).toBe(1)
      expect(report.migratedCount).toBe(0)
      expect(report.outcomes[0].status).toBe('skipped')
    })

    it('migrates brain from CURRENT → CURRENT+2 with synthetic migration files', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      // Provisioned at CURRENT; targetVersion=CURRENT+2 + create synthetic files.
      writeFileSync(join(migrationsDir, `v0.${N1}_migrate.sql`),
        `CREATE TABLE test_n1 (id INTEGER PRIMARY KEY);`)
      writeFileSync(join(migrationsDir, `v0.${N2}_migrate.sql`),
        `CREATE TABLE test_n2 (id INTEGER PRIMARY KEY);`)

      const report = runForwardMigrations({
        control, dataDir, migrationsDir, targetVersion: N2,
      })
      expect(report.migratedCount).toBe(1)
      expect(report.outcomes[0].status).toBe('migrated')
      expect(report.outcomes[0].fromVersion).toBe(V)
      expect(report.outcomes[0].toVersion).toBe(N2)
      expect(report.outcomes[0].appliedVersions).toEqual([N1, N2])

      // Brain DB has the new tables
      const brainDb = new Database(join(dataDir, result.brainFile))
      try {
        const tables = brainDb.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('test_n1', 'test_n2')"
        ).all().map((r: any) => r.name).sort()
        expect(tables).toEqual(['test_n1', 'test_n2'])
      } finally { brainDb.close() }

      // Control plane: brains.schema_version + brain_migrations both updated
      const updated = control.prepare('SELECT schema_version FROM brains WHERE id = ?')
        .get(result.brainId) as { schema_version: number }
      expect(updated.schema_version).toBe(N2)

      const tracked = (control.prepare(
        'SELECT schema_version FROM brain_migrations WHERE brain_id = ? ORDER BY schema_version'
      ).all(result.brainId) as Array<{ schema_version: number }>).map(r => r.schema_version)
      expect(tracked).toEqual([V, N1, N2])
    })

    it('migrates several brains in one run', () => {
      provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      provisionUser({ email: 'b@c.de', agentId: 'b', userId: 'b', control, dataDir })
      provisionUser({ email: 'c@d.de', agentId: 'c', userId: 'c', control, dataDir })

      writeFileSync(join(migrationsDir, `v0.${N1}_migrate.sql`),
        `CREATE TABLE multi_test (id INTEGER PRIMARY KEY);`)

      const report = runForwardMigrations({
        control, dataDir, migrationsDir, targetVersion: N1,
      })
      expect(report.totalBrains).toBe(3)
      expect(report.migratedCount).toBe(3)
      expect(report.failedCount).toBe(0)
    })
  })

  describe('failure handling', () => {
    it('broken SQL fails the preflight: live brain untouched, status ok, schema_version unchanged', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      const brainPath = join(dataDir, result.brainFile)
      const before = readFileSync(brainPath)
      writeFileSync(join(migrationsDir, `v0.${N1}_migrate.sql`),
        `CREATE TABLE foo (id INTEGER  -- syntax error: unclosed paren`)

      const report = runForwardMigrations({
        control, dataDir, migrationsDir, targetVersion: N1,
      })
      expect(report.failedCount).toBe(1)
      expect(report.outcomes[0].status).toBe('failed')
      expect(report.outcomes[0].kind).toBe('preflight_failed')
      expect(report.outcomes[0].error).toMatch(new RegExp(`v0\\.${N1}_migrate\\.sql`))

      const brain = control.prepare('SELECT status, schema_version FROM brains WHERE id = ?')
        .get(result.brainId) as { status: string, schema_version: number }
      expect(brain.status).toBe('ok')
      expect(brain.schema_version).toBe(V)   // unchanged
      expect(readFileSync(brainPath).equals(before)).toBe(true)

      // No brain_migrations row for N1 (failure)
      const tracked = control.prepare(
        'SELECT 1 FROM brain_migrations WHERE brain_id = ? AND schema_version = ?'
      ).get(result.brainId, N1)
      expect(tracked).toBeUndefined()
    })

    it('a missing migration file fails the preflight before anything is touched', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      // no migration files written → v0.N1_migrate.sql missing

      const report = runForwardMigrations({
        control, dataDir, migrationsDir, targetVersion: N1,
      })
      expect(report.failedCount).toBe(1)
      expect(report.outcomes[0].kind).toBe('preflight_failed')
      expect(report.outcomes[0].error).toMatch(new RegExp(`v0\\.${N1}_migrate\\.sql`))
      expect(report.outcomes[0].backupPath).toBeUndefined()

      const brain = control.prepare('SELECT status FROM brains WHERE id = ?')
        .get(result.brainId) as { status: string }
      expect(brain.status).toBe('ok')
    })

    it('flags brain + creates no phantom DB when the brain FILE is missing (v0.10.10 C3)', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      const brainPath = join(dataDir, result.brainFile)
      rmSync(brainPath, { force: true })   // brain data file gone (disk loss / bad mount)

      writeFileSync(join(migrationsDir, `v0.${N1}_migrate.sql`),
        `CREATE TABLE t_n1 (id INTEGER PRIMARY KEY);`)

      const report = runForwardMigrations({
        control, dataDir, migrationsDir, targetVersion: N1,
      })
      expect(report.failedCount).toBe(1)
      expect(report.outcomes[0].status).toBe('failed')
      expect(report.outcomes[0].kind).toBe('brain_missing')

      const brain = control.prepare('SELECT status, schema_version FROM brains WHERE id = ?')
        .get(result.brainId) as { status: string, schema_version: number }
      expect(brain.status).toBe('needs_intervention')
      expect(brain.schema_version).toBe(V)   // not advanced

      // fileMustExist → no empty phantom DB silently recreated in its place
      expect(existsSync(brainPath)).toBe(false)
    })

    it('failure in one brain does not block the others', () => {
      const okResult = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      const failResult = provisionUser({ email: 'b@c.de', agentId: 'b', userId: 'b', control, dataDir })

      writeFileSync(join(migrationsDir, `v0.${N1}_migrate.sql`),
        `CREATE TABLE t_n1 (id INTEGER PRIMARY KEY);`)

      // Set brain "fail" to needs_intervention AFTER provisioning, to simulate
      // one failing (skipped via the status check) while the other must still
      // run.
      control.prepare("UPDATE brains SET status = 'needs_intervention' WHERE id = ?")
        .run(failResult.brainId)

      const report = runForwardMigrations({
        control, dataDir, migrationsDir, targetVersion: N1,
      })
      expect(report.totalBrains).toBe(2)
      expect(report.migratedCount).toBe(1)
      expect(report.skippedCount).toBe(1)

      const okState = control.prepare('SELECT schema_version, status FROM brains WHERE id = ?')
        .get(okResult.brainId) as { schema_version: number, status: string }
      expect(okState.schema_version).toBe(N1)
      expect(okState.status).toBe('ok')

      const failState = control.prepare('SELECT schema_version, status FROM brains WHERE id = ?')
        .get(failResult.brainId) as { schema_version: number, status: string }
      expect(failState.schema_version).toBe(V)
      expect(failState.status).toBe('needs_intervention')
    })
  })

  describe('safety pipeline (v0.14 Cluster 0)', () => {
    const backupsOf = (dir: string) =>
      existsSync(join(dir, 'backups', 'pre-migration'))
        ? readdirSync(join(dir, 'backups', 'pre-migration')).filter(n => n.endsWith('.db'))
        : []
    const reportsOf = (dir: string) =>
      existsSync(join(dir, 'migration-reports'))
        ? readdirSync(join(dir, 'migration-reports')).sort()
            .map(n => JSON.parse(readFileSync(join(dir, 'migration-reports', n), 'utf-8')))
        : []
    const tableExists = (file: string, name: string) => {
      const db = new Database(file, { readonly: true })
      try {
        return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name)
      } finally { db.close() }
    }

    it('success: backup passes integrity_check, report says migrated, control at target', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      writeFileSync(join(migrationsDir, `v0.${N1}_migrate.sql`), `CREATE TABLE ok_n1 (id INTEGER PRIMARY KEY);`)

      const report = runForwardMigrations({
        control, dataDir, migrationsDir, targetVersion: N1, codeVersion: '9.9.9',
      })
      const o = report.outcomes[0]
      expect(o.kind).toBe('migrated')
      expect(o.backupPath && existsSync(o.backupPath)).toBeTruthy()

      const backup = new Database(o.backupPath!, { readonly: true })
      try {
        expect(backup.pragma('integrity_check', { simple: true })).toBe('ok')
        // the backup is the PRE-migration state
        expect(backup.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ok_n1'").get()).toBeUndefined()
      } finally { backup.close() }
      expect(tableExists(join(dataDir, result.brainFile), 'ok_n1')).toBe(true)

      const reports = reportsOf(dataDir)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        brainId: result.brainId, from: V, to: N1, outcome: 'migrated', codeVersion: '9.9.9',
      })
      expect(o.reportPath && existsSync(o.reportPath)).toBeTruthy()
      // no scratch files left behind
      expect(readdirSync(join(dataDir, 'backups', 'pre-migration')).some(n => n.includes('preflight'))).toBe(false)
    })

    it('second file broken: preflight catches it, the first file never reaches the live brain', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      const brainPath = join(dataDir, result.brainFile)
      const before = readFileSync(brainPath)
      writeFileSync(join(migrationsDir, `v0.${N1}_migrate.sql`), `CREATE TABLE first_ok (id INTEGER PRIMARY KEY);`)
      writeFileSync(join(migrationsDir, `v0.${N2}_migrate.sql`), `CREATE TABLE broken (`)

      const report = runForwardMigrations({ control, dataDir, migrationsDir, targetVersion: N2 })
      expect(report.outcomes[0].kind).toBe('preflight_failed')
      expect(report.outcomes[0].error).toMatch(new RegExp(`v0\\.${N2}_migrate\\.sql`))
      expect(readFileSync(brainPath).equals(before)).toBe(true)
      expect(tableExists(brainPath, 'first_ok')).toBe(false)
      expect(reportsOf(dataDir)[0].outcome).toBe('preflight_failed')
    })

    it('live migration fails after a green preflight: backup restored, old schema, status ok', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      const brainPath = join(dataDir, result.brainFile)
      writeFileSync(join(migrationsDir, `v0.${N1}_migrate.sql`), `CREATE TABLE half (id INTEGER PRIMARY KEY);`)

      const report = runForwardMigrations({
        control, dataDir, migrationsDir, targetVersion: N1,
        steps: {
          // simulate a crash half-way: the live brain is changed, then it throws
          applyLive(file) {
            const db = new Database(file)
            try { db.exec('CREATE TABLE half (id INTEGER PRIMARY KEY)') } finally { db.close() }
            throw new Error('disk full (simulated)')
          },
        },
      })
      const o = report.outcomes[0]
      expect(o.kind).toBe('restored')
      expect(o.error).toMatch(/disk full/)
      expect(tableExists(brainPath, 'half')).toBe(false)

      const db = new Database(brainPath, { readonly: true })
      try { expect(db.pragma('integrity_check', { simple: true })).toBe('ok') } finally { db.close() }

      const brain = control.prepare('SELECT status, schema_version FROM brains WHERE id = ?')
        .get(result.brainId) as { status: string, schema_version: number }
      expect(brain).toEqual({ status: 'ok', schema_version: V })
      expect(reportsOf(dataDir)[0].outcome).toBe('restored')
    })

    it('restore fails: needs_intervention, the report names the backup', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      writeFileSync(join(migrationsDir, `v0.${N1}_migrate.sql`), `CREATE TABLE x (id INTEGER PRIMARY KEY);`)

      const report = runForwardMigrations({
        control, dataDir, migrationsDir, targetVersion: N1,
        steps: {
          applyLive() { throw new Error('live failed') },
          restore() { throw new Error('copy failed') },
        },
      })
      const o = report.outcomes[0]
      expect(o.kind).toBe('restore_failed')
      expect(o.error).toMatch(/live failed.*copy failed/)
      expect(o.backupPath && existsSync(o.backupPath)).toBeTruthy()

      const brain = control.prepare('SELECT status FROM brains WHERE id = ?')
        .get(result.brainId) as { status: string }
      expect(brain.status).toBe('needs_intervention')
      expect(reportsOf(dataDir)[0]).toMatchObject({ outcome: 'restore_failed', backupPath: o.backupPath })
    })

    it('backup fails: nothing touched, status ok', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      const brainPath = join(dataDir, result.brainFile)
      const before = readFileSync(brainPath)
      writeFileSync(join(migrationsDir, `v0.${N1}_migrate.sql`), `CREATE TABLE y (id INTEGER PRIMARY KEY);`)

      const report = runForwardMigrations({
        control, dataDir, migrationsDir, targetVersion: N1,
        steps: { backup() { throw new Error('no space left') } },
      })
      expect(report.outcomes[0].kind).toBe('backup_failed')
      expect(readFileSync(brainPath).equals(before)).toBe(true)
      const brain = control.prepare('SELECT status FROM brains WHERE id = ?')
        .get(result.brainId) as { status: string }
      expect(brain.status).toBe('ok')
    })

    it('keeps the newest 3 pre-migration backups per brain', () => {
      provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      for (let i = 1; i <= 5; i++) {
        writeFileSync(join(migrationsDir, `v0.${V + i}_migrate.sql`), `CREATE TABLE r${i} (id INTEGER PRIMARY KEY);`)
        const report = runForwardMigrations({ control, dataDir, migrationsDir, targetVersion: V + i })
        expect(report.outcomes[0].kind).toBe('migrated')
      }
      const kept = backupsOf(dataDir).sort()
      expect(kept).toHaveLength(3)
      // the newest three are the ones taken before v+3, v+4, v+5
      expect(kept.map(n => n.replace(/^.*-v(\d+)\.db$/, '$1')).map(Number))
        .toEqual([V + 2, V + 3, V + 4])
    })

    it('retries on the next start and succeeds once the file is fixed', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      const file = join(migrationsDir, `v0.${N1}_migrate.sql`)
      writeFileSync(file, `CREATE TABLE retry (`)
      expect(runForwardMigrations({ control, dataDir, migrationsDir, targetVersion: N1 }).outcomes[0].kind)
        .toBe('preflight_failed')

      writeFileSync(file, `CREATE TABLE retry (id INTEGER PRIMARY KEY);`)
      const second = runForwardMigrations({ control, dataDir, migrationsDir, targetVersion: N1 })
      expect(second.outcomes[0].kind).toBe('migrated')
      expect(tableExists(join(dataDir, result.brainFile), 'retry')).toBe(true)
      expect(reportsOf(dataDir).map(r => r.outcome)).toEqual(['preflight_failed', 'migrated'])
    })

    it('honours backupDir / reportsDir', () => {
      provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      writeFileSync(join(migrationsDir, `v0.${N1}_migrate.sql`), `CREATE TABLE z (id INTEGER PRIMARY KEY);`)
      const elsewhere = mkdtempSync(join(tmpdir(), 'eml-fm-home-'))
      try {
        const report = runForwardMigrations({
          control, dataDir, migrationsDir, targetVersion: N1,
          backupDir: join(elsewhere, 'backups'), reportsDir: join(elsewhere, 'migration-reports'),
        })
        expect(report.outcomes[0].backupPath!.startsWith(join(elsewhere, 'backups', 'pre-migration'))).toBe(true)
        expect(reportsOf(elsewhere)).toHaveLength(1)
        expect(reportsOf(dataDir)).toHaveLength(0)
      } finally { rmSync(elsewhere, { recursive: true, force: true }) }
    })
  })

  describe('idempotency', () => {
    it('second run after a successful migration → everything skipped', () => {
      provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      writeFileSync(join(migrationsDir, `v0.${N1}_migrate.sql`),
        `CREATE TABLE idem (id INTEGER PRIMARY KEY);`)

      const first = runForwardMigrations({ control, dataDir, migrationsDir, targetVersion: N1 })
      expect(first.migratedCount).toBe(1)

      const second = runForwardMigrations({ control, dataDir, migrationsDir, targetVersion: N1 })
      expect(second.migratedCount).toBe(0)
      expect(second.skippedCount).toBe(1)
    })
  })

  describe('default targetVersion', () => {
    it('uses CURRENT_BRAIN_SCHEMA_VERSION when not provided', () => {
      provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      const report = runForwardMigrations({ control, dataDir, migrationsDir })
      // Brain is at CURRENT, so skipped
      expect(report.skippedCount).toBe(1)
      expect(report.outcomes[0].fromVersion).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
    })
  })
})
