import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME, DATA_DIR, MIGRATION_REPORTS_DIR } from './paths.js'
import { ownVersion, readAppUpdateStatus } from './app-update.js'

/**
 * The update banner's outcome state (v0.14 Cluster 0, decision app-update-flow):
 * the newest brain-migration report the brain server wrote, the in-app update
 * this host started with, whether the user has dismissed them, and whether a
 * failure has since been resolved. Read from files so it works while the server
 * refuses the brain (503 BRAIN_BEHIND_CODE). "Update available" comes from
 * GET /api/app-update; the banner shows both.
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
  /** The report's brain as the user knows it: its space's display name, else the brain's own name. */
  brain: string | null
  /** The user dismissed this report. */
  acknowledged: boolean
  /** A failed report no longer applies: the brain is at or past the report's target now. */
  resolved: boolean
  /** The in-app update or rollback this host runs from, until the user dismisses it. */
  updated: { outcome: 'updated' | 'rolled_back'; from: string; to: string } | null
}

interface Acknowledged {
  /** The report file the user dismissed. */
  acknowledged?: string
  /** The `at` of the in-app update result the user dismissed. */
  result?: string
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

function readAcknowledged(): Acknowledged {
  try {
    return JSON.parse(fs.readFileSync(ACK_FILE, 'utf-8')) as Acknowledged
  } catch {
    return {}
  }
}

/** The last in-app update result, when this host runs the version it went to. */
function currentUpdate(): { at: string; outcome: 'updated' | 'rolled_back'; from: string; to: string } | null {
  const result = readAppUpdateStatus().lastResult
  if (!result || result.outcome === 'failed' || !result.from || !result.to || result.to !== ownVersion()) return null
  return { at: result.at, outcome: result.outcome, from: result.from, to: result.to }
}

/** `spaceName` maps a brain id to its space's display name (undefined: no space holds it). */
export function readUpdateStatus(spaceName: (brainId: string) => string | undefined = () => undefined): UpdateStatus {
  const ack = readAcknowledged()
  const update = currentUpdate()
  const updated = update && ack.result !== update.at ? { outcome: update.outcome, from: update.from, to: update.to } : null
  const report = newestReport()
  if (!report) return { report: null, brain: null, acknowledged: false, resolved: false, updated }
  const version = report.outcome === 'migrated' ? null : brainSchemaVersion(report.brainId)
  return {
    report,
    brain: spaceName(report.brainId) ?? report.brainName,
    acknowledged: ack.acknowledged === report.file,
    resolved: report.outcome === 'migrated' || (version !== null && version >= report.to),
    updated,
  }
}

/**
 * Dismiss the banner for the current report and update. A failure can only be
 * dismissed once it is resolved — while the brain is behind, the banner is the
 * only place that says why the brain is offline.
 */
export function acknowledgeUpdateStatus(): { ok: true } | { ok: false; reason: string } {
  const status = readUpdateStatus()
  const update = currentUpdate()
  if (!status.report && !update) return { ok: false, reason: 'nothing to dismiss' }
  if (status.report && !status.resolved) return { ok: false, reason: 'the brain update has not succeeded yet' }
  const ack: Acknowledged = { ...readAcknowledged(), ...(status.report && { acknowledged: status.report.file }), ...(update && { result: update.at }) }
  fs.writeFileSync(ACK_FILE, JSON.stringify(ack) + '\n', { mode: 0o600 })
  return { ok: true }
}
