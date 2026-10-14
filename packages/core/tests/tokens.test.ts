import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initControlDatabase } from '../src/control'
import {
  issueToken,
  verifyToken,
  revokeToken,
  touchTokenLastUsed,
  TOKEN_BEARER_PREFIX,
  TOKEN_PREFIX_LENGTH,
  TOKEN_SECRET_LENGTH,
} from '../src/tokens'

describe('tokens', () => {
  let db: Database.Database

  beforeEach(() => {
    db = initControlDatabase(':memory:')
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.de')
    db.prepare('INSERT INTO brains (id, name, owner_id, brain_file) VALUES (?, ?, ?, ?)')
      .run('b1', 'x', 'u1', 'brains/b1.db')
  })

  afterEach(() => {
    db.close()
  })

  describe('issueToken', () => {
    it('returns plaintext in eml_<prefix><secret> format', () => {
      const issued = issueToken(db, { userId: 'u1', brainId: 'b1', name: 'Mac MCP' })
      expect(issued.plaintext.startsWith(TOKEN_BEARER_PREFIX)).toBe(true)
      const body = issued.plaintext.slice(TOKEN_BEARER_PREFIX.length)
      expect(body).toHaveLength(TOKEN_PREFIX_LENGTH + TOKEN_SECRET_LENGTH)
      expect(/^[0-9a-f]+$/.test(body)).toBe(true)
    })

    it('persists hash + prefix + name; never plaintext', () => {
      const issued = issueToken(db, { userId: 'u1', brainId: 'b1', name: 'Mac MCP' })
      const row = db.prepare('SELECT * FROM tokens WHERE id = ?').get(issued.tokenId) as {
        token_hash: string, prefix: string, name: string, user_id: string, brain_id: string,
      }
      expect(row.prefix).toBe(issued.prefix)
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.name).toBe('Mac MCP')
      expect(row.user_id).toBe('u1')
      expect(row.brain_id).toBe('b1')

      // Plaintext not persisted in the DB
      const plaintextHits = db.prepare(
        "SELECT COUNT(*) as c FROM tokens WHERE token_hash = ?"
      ).get(issued.plaintext) as { c: number }
      expect(plaintextHits.c).toBe(0)
    })

    it('two issuances → unique IDs + unique plaintexts', () => {
      const a = issueToken(db, { userId: 'u1', brainId: 'b1' })
      const b = issueToken(db, { userId: 'u1', brainId: 'b1' })
      expect(a.tokenId).not.toBe(b.tokenId)
      expect(a.plaintext).not.toBe(b.plaintext)
      expect(a.prefix).not.toBe(b.prefix)
    })

    it('handles null name', () => {
      const issued = issueToken(db, { userId: 'u1', brainId: 'b1' })
      const row = db.prepare('SELECT name FROM tokens WHERE id = ?').get(issued.tokenId) as { name: string | null }
      expect(row.name).toBeNull()
    })
  })

  describe('verifyToken', () => {
    it('valid plaintext → {tokenId, userId, brainId, caller}', () => {
      const issued = issueToken(db, { userId: 'u1', brainId: 'b1' })
      const verified = verifyToken(db, issued.plaintext)
      // no name given → caller is null
      expect(verified).toEqual({ tokenId: issued.tokenId, userId: 'u1', brainId: 'b1', caller: null })
    })

    it('caller mirrors the token name (v0.11 authorship handle)', () => {
      const issued = issueToken(db, { userId: 'u1', brainId: 'b1', name: 'carol' })
      const verified = verifyToken(db, issued.plaintext)
      expect(verified).toEqual({ tokenId: issued.tokenId, userId: 'u1', brainId: 'b1', caller: 'carol' })
    })

    it('null/empty/undefined → null', () => {
      expect(verifyToken(db, null)).toBeNull()
      expect(verifyToken(db, undefined)).toBeNull()
      expect(verifyToken(db, '')).toBeNull()
    })

    it('missing eml_ prefix → null', () => {
      expect(verifyToken(db, 'sk_abcdef')).toBeNull()
      expect(verifyToken(db, 'Bearer eml_xyz')).toBeNull()
    })

    it('wrong body length → null', () => {
      expect(verifyToken(db, 'eml_short')).toBeNull()
      expect(verifyToken(db, 'eml_' + 'a'.repeat(50))).toBeNull()
    })

    it('right format but unknown prefix → null', () => {
      const fake = 'eml_' + 'f'.repeat(TOKEN_PREFIX_LENGTH) + '0'.repeat(TOKEN_SECRET_LENGTH)
      expect(verifyToken(db, fake)).toBeNull()
    })

    it('right prefix wrong secret → null (constant-time hash mismatch)', () => {
      const issued = issueToken(db, { userId: 'u1', brainId: 'b1' })
      const tampered = TOKEN_BEARER_PREFIX + issued.prefix + 'f'.repeat(TOKEN_SECRET_LENGTH)
      expect(verifyToken(db, tampered)).toBeNull()
    })

    it('revoked token → null (partial-index excludes it)', () => {
      const issued = issueToken(db, { userId: 'u1', brainId: 'b1' })
      revokeToken(db, issued.tokenId)
      expect(verifyToken(db, issued.plaintext)).toBeNull()
    })

    it('two tokens with colliding prefix (revoked + active) → returns active only', () => {
      // Active issuance — we extract the prefix
      const active = issueToken(db, { userId: 'u1', brainId: 'b1' })

      // Insert an artificial revoked row with the same prefix (simulates a collision)
      db.prepare(
        `INSERT INTO tokens (id, user_id, brain_id, token_hash, prefix, revoked_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      ).run('t-old', 'u1', 'b1', 'a'.repeat(64), active.prefix)

      const verified = verifyToken(db, active.plaintext)
      expect(verified?.tokenId).toBe(active.tokenId)
    })
  })

  describe('revokeToken', () => {
    it('sets revoked_at + returns true', () => {
      const issued = issueToken(db, { userId: 'u1', brainId: 'b1' })
      const ok = revokeToken(db, issued.tokenId)
      expect(ok).toBe(true)
      const row = db.prepare('SELECT revoked_at FROM tokens WHERE id = ?').get(issued.tokenId) as { revoked_at: string | null }
      expect(row.revoked_at).not.toBeNull()
    })

    it('revoke twice → second call returns false (already revoked, no rows updated)', () => {
      const issued = issueToken(db, { userId: 'u1', brainId: 'b1' })
      expect(revokeToken(db, issued.tokenId)).toBe(true)
      expect(revokeToken(db, issued.tokenId)).toBe(false)
    })

    it('unknown id → false', () => {
      expect(revokeToken(db, 'no-such-id')).toBe(false)
    })
  })

  describe('touchTokenLastUsed', () => {
    it('sets last_used_at to non-null', () => {
      const issued = issueToken(db, { userId: 'u1', brainId: 'b1' })
      const before = db.prepare('SELECT last_used_at FROM tokens WHERE id = ?').get(issued.tokenId) as { last_used_at: string | null }
      expect(before.last_used_at).toBeNull()

      touchTokenLastUsed(db, issued.tokenId)

      const after = db.prepare('SELECT last_used_at FROM tokens WHERE id = ?').get(issued.tokenId) as { last_used_at: string | null }
      expect(after.last_used_at).not.toBeNull()
    })
  })
})
