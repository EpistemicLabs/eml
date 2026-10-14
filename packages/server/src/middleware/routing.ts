import type Database from 'better-sqlite3'
import { CURRENT_BRAIN_SCHEMA_VERSION } from '@engramprotocol/core'
import type { ConnectionPool } from '../pool'

/**
 * Routing middleware. See v0.9-PROPOSAL.md §5.4 step 2.
 *
 * The auth middleware has set (user_id, brain_id). Routing looks up the brain row
 * in the control plane (path + status) and gets the DB connection for that brain
 * from the connection pool.
 */

export interface RoutingContext {
  brainId: string
  brainName: string
  brainFile: string
  brainDb: Database.Database
}

export type RoutingResult =
  | { ok: true, ctx: RoutingContext }
  | { ok: false, status: number, error: string, code?: string }

export function route(
  control: Database.Database,
  pool: ConnectionPool,
  brainId: string,
): RoutingResult {
  const row = control.prepare(
    `SELECT name, brain_file, status, schema_version FROM brains WHERE id = ?`,
  ).get(brainId) as { name: string, brain_file: string, status: string, schema_version: number } | undefined

  if (!row) {
    return { ok: false, status: 404, error: 'brain not found in control-plane' }
  }
  if (row.status === 'needs_intervention') {
    return {
      ok: false,
      status: 503,
      error: 'brain needs intervention (see operator tooling — e.g. migration failure)',
    }
  }
  // v0.14 Cluster 0: a failed or pending migration leaves the brain on its old
  // schema. This code expects the current one, so it must not serve the brain;
  // the previous app version still can. The migration report says why.
  if (row.schema_version < CURRENT_BRAIN_SCHEMA_VERSION) {
    return {
      ok: false,
      status: 503,
      code: 'BRAIN_BEHIND_CODE',
      error: `brain is on schema v${row.schema_version}, this server needs v${CURRENT_BRAIN_SCHEMA_VERSION} — ` +
        'the migration did not complete (see the latest migration report)',
    }
  }

  try {
    const brainDb = pool.acquire(brainId, row.brain_file)
    return { ok: true, ctx: { brainId, brainName: row.name, brainFile: row.brain_file, brainDb } }
  } catch (err) {
    // v0.10.10 C3: a missing brain file (fileMustExist → SQLITE_CANTOPEN) is an
    // operator condition, not a 500 — the data file for a registered brain is gone.
    // Signal 503 + needs_intervention so writes are NOT routed into a phantom DB.
    // We do NOT auto-flip control-plane status here: a transient FS blip at deploy
    // shouldn't permanently lock a brain. The migration path flips it deliberately.
    if ((err as { code?: string }).code === 'SQLITE_CANTOPEN') {
      return {
        ok: false,
        status: 503,
        error: 'brain data file missing — operator intervention required (needs_intervention)',
      }
    }
    return {
      ok: false,
      status: 500,
      error: `failed to open brain-DB: ${(err as Error).message}`,
    }
  }
}
