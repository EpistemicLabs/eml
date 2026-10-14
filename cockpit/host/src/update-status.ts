import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME, DATA_DIR, MIGRATION_REPORTS_DIR } from './paths.js'

/**
 * The update banner's state (v0.14 Cluster 0, decision app-update-flow): the
 * newest brain-migration report the brain server wrote, whether the user has
 * dismissed it, and whether a failure has since been resolved. Read from files
 * so it works while the server refuses the brain (503 BRAIN_BEHIND_CODE).
 * Later the same endpoint carries "update available".
 */

const require = createRequire(import.meta.url)
type Db = { prepare(sql: string): { get(...args: unknown[]): unknown }; close(): void }
const Database = require('better-sqlite3') as new (file: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => Db

const CONTROL_DB = path.join(DATA_DIR, 'control.db')
const ACK_FILE = path.join(COCKPIT_HOME, 'update-status.json')

export interface MigrationReport {
  brainId: string
  brainName: string
  from: number
  to: number
  outcome: 'migrated' | 'brain_missing' | 'backup_failed' | 'preflight_failed' | 'restored' | 'restore_failed'
  error?: string
  backupPath?: string
  codeVersion?: string
  at: string
}

export interface UpdateStatus {
  report: (MigrationReport & { file: string; reportPath: string }) | null
  /** The user dismissed this report. */
  acknowledged: boolean
  /** A failed report no longer applies: the brain is at or past the report's target now. */
  resolved: boolean
}

function newestReport(): UpdateStatus['report'] {
  if (!fs.existsSync(MIGRATION_REPORTS_DIR)) return null
  // Names start with a sortable UTC stamp.
  const files = fs.readdirSync(MIGRATION_REPORTS_DIR).filter((n) => n.endsWith('.json')).sort()
  for (const file of files.reverse()) {
    const reportPath = path.join(MIGRATION_REPORTS_DIR, file)
    try {
      return { ...(JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as MigrationReport), file, reportPath }
    } catch { /* unreadable report: try the next older one */ }
  }
  return null
}

function brainSchemaVersion(brainId: string): number | null {
  if (!fs.existsSync(CONTROL_DB)) return null
  const control = new Database(CONTROL_DB, { readonly: true, fileMustExist: true })
  try {
    const row = control.prepare('SELECT schema_version FROM brains WHERE id = ?').get(brainId) as
      | { schema_version: number }
      | undefined
    return row?.schema_version ?? null
  } finally {
    control.close()
  }
}

function acknowledgedFile(): string | null {
  try {
    return (JSON.parse(fs.readFileSync(ACK_FILE, 'utf-8')) as { acknowledged?: string }).acknowledged ?? null
  } catch {
    return null
  }
}

export function readUpdateStatus(): UpdateStatus {
  const report = newestReport()
  if (!report) return { report: null, acknowledged: false, resolved: false }
  const version = report.outcome === 'migrated' ? null : brainSchemaVersion(report.brainId)
  return {
    report,
    acknowledged: acknowledgedFile() === report.file,
    resolved: report.outcome === 'migrated' || (version !== null && version >= report.to),
  }
}

/**
 * Dismiss the banner for the current report. A failure can only be dismissed
 * once it is resolved — while the brain is behind, the banner is the only
 * place that says why the brain is offline.
 */
export function acknowledgeUpdateStatus(): { ok: true } | { ok: false; reason: string } {
  const status = readUpdateStatus()
  if (!status.report) return { ok: false, reason: 'no report' }
  if (!status.resolved) return { ok: false, reason: 'the brain update has not succeeded yet' }
  fs.writeFileSync(ACK_FILE, JSON.stringify({ acknowledged: status.report.file }) + '\n', { mode: 0o600 })
  return { ok: true }
}
