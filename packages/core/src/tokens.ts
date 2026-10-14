import type Database from 'better-sqlite3'
import { randomBytes, createHash, timingSafeEqual } from 'crypto'
import { v4 as uuidv4 } from 'uuid'

/**
 * Token-Format: `eml_<prefix><secret>` (8 + 32 hex chars).
 *
 * Storage in control.tokens (see packages/core/migrations/control/v0.9.sql):
 * - prefix: first 8 hex chars of the plaintext (lookup index, partial WHERE revoked_at IS NULL)
 * - token_hash: SHA-256 of the secret part (32 chars)
 * - plaintext is never persisted; printed once at issuance time
 *
 * Lookup-Path: prefix → row(s) → sha256(secret) === token_hash (constant-time)
 *
 * See v0.9-PROPOSAL.md §5.2 + §5.3 + cluster-a-explained §2.
 */

export const TOKEN_BEARER_PREFIX = 'eml_'
export const TOKEN_PREFIX_LENGTH = 8
export const TOKEN_SECRET_LENGTH = 32

export interface IssuedToken {
  tokenId: string
  plaintext: string
  prefix: string
}

export interface VerifiedToken {
  tokenId: string
  userId: string
  brainId: string
  // v0.11 team-brains: the token's name doubles as the caller/authorship handle
  // (Weg A). Stamped server-side into engrams.ingested_by on every write, so
  // authorship is derived from the authenticated token — not client-reported.
  caller: string | null
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  // Both inputs are hex strings of equal length → comparing them as utf-8 buffers is constant-time-safe.
  return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'))
}

export function issueToken(
  control: Database.Database,
  opts: { userId: string, brainId: string, name?: string | null },
): IssuedToken {
  const tokenId = uuidv4()
  const prefix = randomHex(TOKEN_PREFIX_LENGTH / 2)   // 4 bytes → 8 hex chars
  const secret = randomHex(TOKEN_SECRET_LENGTH / 2)   // 16 bytes → 32 hex chars
  const tokenHash = sha256Hex(secret)
  const plaintext = `${TOKEN_BEARER_PREFIX}${prefix}${secret}`

  control.prepare(
    `INSERT INTO tokens (id, user_id, brain_id, name, token_hash, prefix)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(tokenId, opts.userId, opts.brainId, opts.name ?? null, tokenHash, prefix)

  return { tokenId, plaintext, prefix }
}

export function verifyToken(
  control: Database.Database,
  plaintext: string | undefined | null,
): VerifiedToken | null {
  if (!plaintext || !plaintext.startsWith(TOKEN_BEARER_PREFIX)) return null
  const body = plaintext.slice(TOKEN_BEARER_PREFIX.length)
  if (body.length !== TOKEN_PREFIX_LENGTH + TOKEN_SECRET_LENGTH) return null

  const prefix = body.slice(0, TOKEN_PREFIX_LENGTH)
  const secret = body.slice(TOKEN_PREFIX_LENGTH)
  const candidateHash = sha256Hex(secret)

  const rows = control.prepare(
    `SELECT id, user_id, brain_id, name, token_hash
     FROM tokens
     WHERE prefix = ? AND revoked_at IS NULL`,
  ).all(prefix) as Array<{ id: string, user_id: string, brain_id: string, name: string | null, token_hash: string }>

  for (const row of rows) {
    if (constantTimeStringEqual(row.token_hash, candidateHash)) {
      return { tokenId: row.id, userId: row.user_id, brainId: row.brain_id, caller: row.name }
    }
  }
  return null
}

export function revokeToken(control: Database.Database, tokenId: string): boolean {
  const info = control.prepare(
    `UPDATE tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL`,
  ).run(tokenId)
  return info.changes > 0
}

export function touchTokenLastUsed(control: Database.Database, tokenId: string): void {
  control.prepare(
    `UPDATE tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).run(tokenId)
}
