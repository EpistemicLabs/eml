import type Database from 'better-sqlite3'
import { verifyToken, touchTokenLastUsed } from '@engramprotocol/core'

/**
 * Auth middleware (bearer token only in v0.9). See v0.9-PROPOSAL.md §5.4.
 *
 * A pure function adapter with no HTTP coupling — server.ts calls it with the
 * Authorization header, gets back either a context or an error status, and
 * decides itself how to respond.
 */

export interface AuthContext {
  tokenId: string
  brainId: string
  // v0.11 team-brains: authorship handle derived from the token (= tokens.name).
  // Stamped server-side into engrams.ingested_by — never read from the request body.
  caller: string | null
}

export type AuthResult =
  | { ok: true, ctx: AuthContext }
  | { ok: false, status: number, error: string }

export function authenticate(
  control: Database.Database,
  authorizationHeader: string | undefined | null,
): AuthResult {
  if (!authorizationHeader) {
    return { ok: false, status: 401, error: 'missing Authorization header' }
  }
  const match = /^Bearer\s+(\S+)$/.exec(authorizationHeader.trim())
  if (!match) {
    return { ok: false, status: 401, error: 'malformed Authorization header (expected "Bearer <token>")' }
  }

  const verified = verifyToken(control, match[1])
  if (!verified) {
    return { ok: false, status: 401, error: 'invalid or revoked token' }
  }

  // The last_used_at update is sync (better-sqlite3) but lightweight — a single UPDATE by PK.
  // v0.9 spec §5.4 notes "async, no blocking", but sync is fine with better-sqlite3.
  try { touchTokenLastUsed(control, verified.tokenId) } catch { /* non-fatal */ }

  return { ok: true, ctx: verified }
}
