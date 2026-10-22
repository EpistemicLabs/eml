import path from 'path'
import { rmSync, mkdirSync } from 'fs'
import type Database from 'better-sqlite3'
import { randomUUID as uuidv4 } from 'crypto'
import { CURRENT_BRAIN_SCHEMA_VERSION } from './control'
import { seedDefaultBrain } from './default-brain'
import { issueToken } from './tokens'

/**
 * Sync-Provisioning (v0.9-PROPOSAL §5.6).
 *
 * Atomic bootstrap flow for new users:
 *   1. Create the brain file + seed it with default engrams  (outside the transaction)
 *   2. Control-plane transaction:
 *      - users-row (upsert via ON CONFLICT(email) DO NOTHING — re-runs reuse user)
 *      - brains row with the current schema_version
 *      - brain_members(role='owner')
 *      - brain_migrations(brain_id, schema_version)
 *      - tokens-row via issueToken()
 *
 * On failure in step 2 → compensating transaction: rm the brain file
 * (the control plane is rolled back automatically by SQLite).
 *
 * Edge case: crash between step 1 and step 2 → orphaned brain file. In v0.9
 * this can be cleaned up manually with 2 builders; a background sweep is
 * mandatory before public release (see risk catalog).
 */

export interface ProvisionOptions {
  email: string
  agentId: string                  // primary agent slug (e.g. 'assistant', 'helper')
  userId: string                   // user slug in the brain (e.g. 'alice', 'bob')
  agentName?: string               // display names for the seeded profiles (default: the ids)
  userName?: string
  control: Database.Database
  dataDir: string                  // <data-dir>; the brain is created at <data-dir>/brains/<uuid>.db
  tokenName?: string               // optional label for issueToken (default 'bootstrap')
}

export interface ProvisionResult {
  userId: string
  brainId: string
  brainFile: string                // relative path ('brains/<uuid>.db')
  tokenId: string
  tokenPlaintext: string           // printed to stdout once by the CLI
}

export function provisionUser(opts: ProvisionOptions): ProvisionResult {
  const newUserId = uuidv4()
  const brainId = uuidv4()
  const brainFile = path.posix.join('brains', `${brainId}.db`)
  const brainPath = path.join(opts.dataDir, brainFile)

  // Ensure <data-dir>/brains/ exists (idempotent)
  mkdirSync(path.dirname(brainPath), { recursive: true })

  // Step 1 — brain file + default brain seed.
  // If this fails there is no control-plane state yet → just rm the file.
  try {
    seedDefaultBrain(brainPath, opts.agentId, opts.userId, { agentName: opts.agentName, userName: opts.userName })
  } catch (err) {
    rmSync(brainPath, { force: true })
    throw err
  }

  // Step 2 — atomic control-plane transaction.
  try {
    const txn = opts.control.transaction(() => {
      opts.control.prepare(
        `INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(email) DO NOTHING`,
      ).run(newUserId, opts.email)

      const userRow = opts.control.prepare(
        `SELECT id FROM users WHERE email = ?`,
      ).get(opts.email) as { id: string } | undefined
      if (!userRow) {
        throw new Error(`provisionUser: user row for email=${opts.email} not resolvable`)
      }
      const resolvedUserId = userRow.id

      opts.control.prepare(
        `INSERT INTO brains (id, name, owner_id, brain_file, schema_version)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        brainId,
        opts.agentId,
        resolvedUserId,
        brainFile,
        CURRENT_BRAIN_SCHEMA_VERSION,
      )

      opts.control.prepare(
        `INSERT INTO brain_members (brain_id, user_id, role) VALUES (?, ?, 'owner')
         ON CONFLICT(brain_id, user_id) DO NOTHING`,
      ).run(brainId, resolvedUserId)

      opts.control.prepare(
        `INSERT INTO brain_migrations (brain_id, schema_version) VALUES (?, ?)`,
      ).run(brainId, CURRENT_BRAIN_SCHEMA_VERSION)

      const issued = issueToken(opts.control, {
        userId: resolvedUserId,
        brainId,
        name: opts.tokenName ?? 'bootstrap',
      })
      return { resolvedUserId, issued }
    })

    const { resolvedUserId, issued } = txn()

    return {
      userId: resolvedUserId,
      brainId,
      brainFile,
      tokenId: issued.tokenId,
      tokenPlaintext: issued.plaintext,
    }
  } catch (err) {
    // Compensating transaction: brain file cleanup. Control-plane state is
    // already clean through the SQLite transaction rollback.
    rmSync(brainPath, { force: true })
    throw err
  }
}
