import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME, DATA_DIR, MIGRATION_REPORTS_DIR } from './paths.js'
import { ownVersion, readAppUpdateStatus } from './app-update.js'

/**
 * The update banner's outcome state (v0.14 Cluster 0, decision app-update-flow):
 * per brain the newest migration report the brain server wrote, the in-app
 * update this host started with, what the user has dismissed, and whether a
 * failure has since been resolved. Read from files so it works while the server
 * refuses a brain (503 BRAIN_BEHIND_CODE). "Update available" comes from
 * GET /api/app-update; the banner shows both.
 *
 * A start migrates every brain and writes one report each, so the status is per
 * brain: each space shows its own brain's report, and one brain's success never
 * hides another brain's failure.
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

export interface BrainUpdateStatus {
  report: MigrationReport & { file: string; reportPath: string }
  /** The report's brain as the user knows it: its space's display name, else the brain's own name. */
  brain: string
  /** The user dismissed this report. */
  acknowledged: boolean
  /** A failed report no longer applies: the brain is at or past the report's target now. */
  resolved: boolean
}

export interface UpdateStatus {
  /** The newest report of each brain that has one, by brain id. */
  brains: Record<string, BrainUpdateStatus>
  /** The in-app update or rollback this host runs from, until the user dismisses it. */
  updated: { outcome: 'updated' | 'rolled_back'; from: string; to: string } | null
}

interface Acknowledged {
  /** The report files the user dismissed (up to v0.20.5 a single file name). */
  acknowledged?: string[] | string
  /** The `at` of the in-app update result the user dismissed. */
  result?: string
}

function newestReports(): Array<BrainUpdateStatus['report']> {
  if (!fs.existsSync(MIGRATION_REPORTS_DIR)) return []
  // Names start with a sortable UTC stamp: newest first, the first readable report of a brain wins.
  const files = fs.readdirSync(MIGRATION_REPORTS_DIR).filter((n) => n.endsWith('.json')).sort().reverse()
  const byBrain = new Map<string, BrainUpdateStatus['report']>()
  for (const file of files) {
    const reportPath = path.join(MIGRATION_REPORTS_DIR, file)
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as MigrationReport
      if (typeof report.brainId === 'string' && !byBrain.has(report.brainId)) byBrain.set(report.brainId, { ...report, file, reportPath })
    } catch { /* unreadable report: the brain's next older one counts */ }
  }
  return [...byBrain.values()]
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

const acknowledgedFiles = (ack: Acknowledged): string[] =>
  Array.isArray(ack.acknowledged) ? ack.acknowledged : ack.acknowledged ? [ack.acknowledged] : []

/** The last in-app update result, when this host runs the version it went to. */
function currentUpdate(): { at: string; outcome: 'updated' | 'rolled_back'; from: string; to: string } | null {
  const result = readAppUpdateStatus().lastResult
  if (!result || result.outcome === 'failed' || !result.from || !result.to || result.to !== ownVersion()) return null
  return { at: result.at, outcome: result.outcome, from: result.from, to: result.to }
}

/** `spaceName` maps a brain id to its space's display name (undefined: no space holds it). */
export function readUpdateStatus(spaceName: (brainId: string) => string | undefined = () => undefined): UpdateStatus {
  const ack = readAcknowledged()
  const dismissed = new Set(acknowledgedFiles(ack))
  const update = currentUpdate()
  const updated = update && ack.result !== update.at ? { outcome: update.outcome, from: update.from, to: update.to } : null
  const brains: UpdateStatus['brains'] = {}
  for (const report of newestReports()) {
    const version = report.outcome === 'migrated' ? null : brainSchemaVersion(report.brainId)
    brains[report.brainId] = {
      report,
      brain: spaceName(report.brainId) ?? report.brainName,
      acknowledged: dismissed.has(report.file),
      resolved: report.outcome === 'migrated' || (version !== null && version >= report.to),
    }
  }
  return { brains, updated }
}

/**
 * Dismiss the banner of one brain's space: that brain's report and the in-app
 * update. A failure can only be dismissed once it is resolved — while the brain
 * is behind, the banner is the only place that says why it is offline.
 */
export function acknowledgeUpdateStatus(brainId: string): { ok: true } | { ok: false; reason: string } {
  const own = readUpdateStatus().brains[brainId]
  const update = currentUpdate()
  if (!own && !update) return { ok: false, reason: 'nothing to dismiss' }
  if (own && !own.resolved) return { ok: false, reason: 'the brain update has not succeeded yet' }
  const ack = readAcknowledged()
  // Keep only what still names a brain's newest report, so the file does not grow with every update.
  const current = new Set(newestReports().map((r) => r.file))
  const files = [...new Set([...acknowledgedFiles(ack), ...(own ? [own.report.file] : [])])].filter((f) => current.has(f))
  const next: Acknowledged = { ...ack, acknowledged: files, ...(update && { result: update.at }) }
  fs.writeFileSync(ACK_FILE, JSON.stringify(next) + '\n', { mode: 0o600 })
  return { ok: true }
}
