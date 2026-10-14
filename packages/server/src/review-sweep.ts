import path from 'path'
import Database from 'better-sqlite3'
import type Database_t from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '@engramprotocol/core'

/** The sweep reads tables from the current schema (labels since 13, task_entries
 *  since 15), so it only touches brains that are fully migrated. A brain left on
 *  an older schema by a failed migration stays untouched, as the pipeline promises. */
const SWEEP_MIN_SCHEMA = CURRENT_BRAIN_SCHEMA_VERSION

/**
 * v0.13: nightly deterministic review-label sweep (labels axis).
 *
 * The ONLY writer of the `review` label in the MVP. Iterates every registered
 * brain and stamps `review` on active decision/rule/profile whose review_due_at
 * has passed (EngramStore.stampDueReviewLabels — pure date-compare, no LLM).
 *
 * Brain enumeration mirrors runForwardMigrations: read the control-plane `brains`
 * table, resolve each brain_file, open a short-lived connection (fileMustExist),
 * stamp, close. Fresh per-brain connections (not the request pool) so the sweep
 * never evicts the pool's working set. A brain that throws is isolated — the
 * others still get swept. Idempotent, so re-running is cheap.
 *
 * Runs once at server start (fresh labels on deploy) + on a daily timer.
 */

export interface ReviewSweepReport {
  totalBrains: number
  sweptCount: number    // brains successfully opened + stamped
  stampedCount: number  // total newly-stamped `review` labels across all brains
  failedCount: number
  failures: Array<{ brainId: string, brainName: string, error: string }>
}

export interface RunReviewSweepOptions {
  control: Database_t.Database
  dataDir: string
  now?: string          // ISO cutoff; defaults to now. Injectable for tests.
}

export function runReviewSweep(opts: RunReviewSweepOptions): ReviewSweepReport {
  // Only brains that are healthy AND already migrated to the labels schema (13).
  // Startup forward-migration brings brains to current before this runs; a brain
  // below 13 (e.g. needs_intervention) has no engram_labels table — skip it.
  const brains = opts.control.prepare(
    `SELECT id, name, brain_file, schema_version, status FROM brains
     WHERE status = 'ok' AND schema_version >= ?`,
  ).all(SWEEP_MIN_SCHEMA) as Array<{
    id: string, name: string, brain_file: string, schema_version: number, status: string,
  }>

  let sweptCount = 0
  let stampedCount = 0
  const failures: ReviewSweepReport['failures'] = []

  for (const brain of brains) {
    const brainPath = path.isAbsolute(brain.brain_file)
      ? brain.brain_file
      : path.join(opts.dataDir, brain.brain_file)

    let db: Database_t.Database | null = null
    try {
      db = new Database(brainPath, { fileMustExist: true })
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      const eml = EML.fromConnection(db, brain.name)
      stampedCount += eml.engrams.stampDueReviewLabels(opts.now)
      sweptCount++
    } catch (err) {
      failures.push({ brainId: brain.id, brainName: brain.name, error: (err as Error).message })
    } finally {
      if (db) { try { db.close() } catch { /* best-effort */ } }
    }
  }

  return {
    totalBrains: brains.length,
    sweptCount,
    stampedCount,
    failedCount: failures.length,
    failures,
  }
}

/**
 * Fire the sweep once now, then every `intervalMs` (default daily). The timer is
 * unref'd so it never keeps the process alive on its own. Returns a stop handle.
 */
export function startReviewSweepScheduler(opts: RunReviewSweepOptions & { intervalMs?: number }): () => void {
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000

  const tick = () => {
    try {
      const report = runReviewSweep(opts)
      if (report.stampedCount > 0 || report.failedCount > 0) {
        console.log(
          `[review-sweep] ${report.sweptCount}/${report.totalBrains} brains, ` +
          `${report.stampedCount} newly flagged, ${report.failedCount} failed`,
        )
      }
      for (const f of report.failures) {
        console.error(`[review-sweep] ${f.brainId} (${f.brainName}): ${f.error}`)
      }
    } catch (err) {
      console.error(`[review-sweep] sweep run failed: ${(err as Error).message}`)
    }
  }

  tick() // once at startup — fresh labels on deploy
  const timer = setInterval(tick, intervalMs)
  if (timer.unref) timer.unref()
  return () => clearInterval(timer)
}
