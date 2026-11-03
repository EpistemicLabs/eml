import path from 'path'
import { rmSync, mkdirSync, existsSync } from 'fs'
import type Database from 'better-sqlite3'
import { randomUUID as uuidv4 } from 'crypto'
import { CURRENT_BRAIN_SCHEMA_VERSION } from './control'
import { initDatabase } from './database'
import { seedDefaultBrain } from './default-brain'
import { issueToken } from './tokens'

/**
 * Sync-Provisioning (v0.9-PROPOSAL §5.6).
 *
 * Atomic bootstrap flow for new users:
 *   1. Create the brain file + seed it with default engrams  (outside the transaction)
 *   2. Control-plane transaction (registerBrain):
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
 *
 * v0.21: provisionBrain is the same flow for a shared brain in the making —
 * an empty brain (the schema, no rows, no genesis) under an id that is given,
 * not drawn: the team brain's id from its creation grant or its invite link.
 * Its genesis comes from the relay (POST /team/create or /team/join).
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

/** v0.21: an empty brain for a team brain the relay will give its genesis. */
export interface ProvisionBrainOptions {
  email: string                    // the owner in the control plane (upserted, as in provisionUser)
  brainId: string                  // the team brain's id — from its creation grant or its invite link
  name: string                     // brains.name: the space's own name
  control: Database.Database
  dataDir: string
  tokenName: string                // the member's handle
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function provisionUser(opts: ProvisionOptions): ProvisionResult {
  const brainId = uuidv4()
  const { brainFile, brainPath } = brainLocation(opts.dataDir, brainId)

  // Step 1 — brain file + default brain seed.
  // If this fails there is no control-plane state yet → just rm the file.
  try {
    seedDefaultBrain(brainPath, opts.agentId, opts.userId, { agentName: opts.agentName, userName: opts.userName }, brainId)
  } catch (err) {
    rmSync(brainPath, { force: true })
    throw err
  }

  return registerBrain({ control: opts.control, email: opts.email, brainId, name: opts.agentId, brainFile, brainPath, tokenName: opts.tokenName ?? 'bootstrap' })
}

/**
 * v0.21: provisions an empty brain under `brainId` — the schema, no rows, no
 * genesis (initDatabase with log: false) — and registers it in the control
 * plane like provisionUser does. Such a brain takes no write until its
 * genesis arrives from its relay. Refuses an id that is not a lowercase UUID
 * or a brain that exists already.
 */
export function provisionBrain(opts: ProvisionBrainOptions): ProvisionResult {
  if (!UUID.test(opts.brainId)) throw new Error('provisionBrain: the brain id is not a lowercase UUID')
  const { brainFile, brainPath } = brainLocation(opts.dataDir, opts.brainId)
  if (existsSync(brainPath) || opts.control.prepare('SELECT 1 FROM brains WHERE id = ?').get(opts.brainId)) {
    throw new Error(`provisionBrain: brain ${opts.brainId} exists already`)
  }

  try {
    initDatabase(brainPath, undefined, opts.brainId, { log: false }).close()
  } catch (err) {
    rmSync(brainPath, { force: true })
    throw err
  }

  return registerBrain({ control: opts.control, email: opts.email, brainId: opts.brainId, name: opts.name, brainFile, brainPath, tokenName: opts.tokenName })
}

/** Where a brain's file goes: <data-dir>/brains/<id>.db, the directory made if missing. */
function brainLocation(dataDir: string, brainId: string): { brainFile: string, brainPath: string } {
  const brainFile = path.posix.join('brains', `${brainId}.db`)
  const brainPath = path.join(dataDir, brainFile)
  mkdirSync(path.dirname(brainPath), { recursive: true })
  return { brainFile, brainPath }
}

/** Step 2 — the control-plane transaction for a brain file that exists; on failure the file is removed again. */
function registerBrain(args: { control: Database.Database, email: string, brainId: string, name: string, brainFile: string, brainPath: string, tokenName: string }): ProvisionResult {
  const { control, brainId } = args
  try {
    const txn = control.transaction(() => {
      control.prepare(
        `INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(email) DO NOTHING`,
      ).run(uuidv4(), args.email)

      const userRow = control.prepare(
        `SELECT id FROM users WHERE email = ?`,
      ).get(args.email) as { id: string } | undefined
      if (!userRow) {
        throw new Error(`provisionUser: user row for email=${args.email} not resolvable`)
      }
      const resolvedUserId = userRow.id

      control.prepare(
        `INSERT INTO brains (id, name, owner_id, brain_file, schema_version)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        brainId,
        args.name,
        resolvedUserId,
        args.brainFile,
        CURRENT_BRAIN_SCHEMA_VERSION,
      )

      control.prepare(
        `INSERT INTO brain_members (brain_id, user_id, role) VALUES (?, ?, 'owner')
         ON CONFLICT(brain_id, user_id) DO NOTHING`,
      ).run(brainId, resolvedUserId)

      control.prepare(
        `INSERT INTO brain_migrations (brain_id, schema_version) VALUES (?, ?)`,
      ).run(brainId, CURRENT_BRAIN_SCHEMA_VERSION)

      const issued = issueToken(control, {
        userId: resolvedUserId,
        brainId,
        name: args.tokenName,
      })
      return { resolvedUserId, issued }
    })

    const { resolvedUserId, issued } = txn()

    return {
      userId: resolvedUserId,
      brainId,
      brainFile: args.brainFile,
      tokenId: issued.tokenId,
      tokenPlaintext: issued.plaintext,
    }
  } catch (err) {
    // Compensating transaction: brain file cleanup. Control-plane state is
    // already clean through the SQLite transaction rollback.
    rmSync(args.brainPath, { force: true })
    throw err
  }
}
