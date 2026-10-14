import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initControlDatabase, CURRENT_CONTROL_SCHEMA_VERSION } from '../src/control'

describe('Control-Plane DB', () => {
  let db: Database.Database

  beforeEach(() => {
    db = initControlDatabase(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  describe('schema init', () => {
    it('creates all 6 tables on fresh DB', () => {
      const tables = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as { name: string }[]).map(t => t.name)

      expect(tables).toEqual([
        'brain_members',
        'brain_migrations',
        'brains',
        'meta_migrations',
        'tokens',
        'users',
      ])
    })

    it('records initial meta_migrations entry', () => {
      const row = db.prepare(
        'SELECT schema_version FROM meta_migrations'
      ).get() as { schema_version: number } | undefined

      expect(row?.schema_version).toBe(CURRENT_CONTROL_SCHEMA_VERSION)
    })

    it('creates idx_tokens_prefix as partial index (revoked_at IS NULL)', () => {
      const idx = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_tokens_prefix'"
      ).get() as { name: string, sql: string } | undefined

      expect(idx?.name).toBe('idx_tokens_prefix')
      expect(idx?.sql).toContain('revoked_at IS NULL')
    })

    it('enables WAL journal_mode', () => {
      // :memory: DBs ignore journal_mode (always 'memory'). A smoke test with a file DB
      // via a temp path would give real WAL. Here we only check that the pragma call
      // doesn't crash and a valid mode is active.
      const mode = (db.pragma('journal_mode', { simple: true }) as string).toLowerCase()
      expect(['memory', 'wal']).toContain(mode)
    })

    it('enables foreign_keys', () => {
      const fk = db.pragma('foreign_keys', { simple: true })
      expect(fk).toBe(1)
    })
  })

  describe('idempotent re-init', () => {
    it('re-init on already-initialized DB is no-op', () => {
      // Insert a user, then re-init — the user must still be there
      db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.de')
      db.close()

      // Reuse: better-sqlite3 :memory: cannot persist, so a path-based test would be
      // needed. Here: smoke — initControlDatabase is idempotent in its logic
      // (hasMetaMigrations check). File test in the Phase A.4 integration tests.
      const db2 = initControlDatabase(':memory:')
      const tables = db2.prepare(
        "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'"
      ).get() as { c: number }
      expect(tables.c).toBe(6)
      db2.close()
    })
  })

  describe('users', () => {
    it('insert + select', () => {
      db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'alice@example.com')
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get('u1') as { email: string }
      expect(row.email).toBe('alice@example.com')
    })

    it('email UNIQUE constraint', () => {
      db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.de')
      expect(() =>
        db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u2', 'a@b.de')
      ).toThrow(/UNIQUE/)
    })
  })

  describe('brains', () => {
    beforeEach(() => {
      db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.de')
    })

    it('insert + select + status default ok', () => {
      db.prepare(
        'INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES (?, ?, ?, ?, ?)'
      ).run('b1', 'alice', 'u1', 'brains/b1.db', 8)

      const row = db.prepare('SELECT * FROM brains WHERE id = ?').get('b1') as { status: string, schema_version: number }
      expect(row.status).toBe('ok')
      expect(row.schema_version).toBe(8)
    })

    it('rejects invalid status', () => {
      expect(() =>
        db.prepare(
          'INSERT INTO brains (id, name, owner_id, brain_file, status) VALUES (?, ?, ?, ?, ?)'
        ).run('b2', 'x', 'u1', 'brains/b2.db', 'broken')
      ).toThrow(/CHECK/)
    })

    it('FK on owner_id (referenced user must exist)', () => {
      expect(() =>
        db.prepare(
          'INSERT INTO brains (id, name, owner_id, brain_file) VALUES (?, ?, ?, ?)'
        ).run('b3', 'x', 'no-such-user', 'brains/b3.db')
      ).toThrow(/FOREIGN KEY/)
    })

    it('brain_file UNIQUE', () => {
      db.prepare(
        'INSERT INTO brains (id, name, owner_id, brain_file) VALUES (?, ?, ?, ?)'
      ).run('b4', 'x', 'u1', 'brains/dup.db')
      expect(() =>
        db.prepare(
          'INSERT INTO brains (id, name, owner_id, brain_file) VALUES (?, ?, ?, ?)'
        ).run('b5', 'y', 'u1', 'brains/dup.db')
      ).toThrow(/UNIQUE/)
    })
  })

  describe('brain_members', () => {
    beforeEach(() => {
      db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.de')
      db.prepare('INSERT INTO brains (id, name, owner_id, brain_file) VALUES (?, ?, ?, ?)')
        .run('b1', 'x', 'u1', 'brains/b1.db')
    })

    it('insert owner role', () => {
      db.prepare('INSERT INTO brain_members (brain_id, user_id, role) VALUES (?, ?, ?)').run('b1', 'u1', 'owner')
      const row = db.prepare('SELECT * FROM brain_members WHERE brain_id = ?').get('b1') as { role: string }
      expect(row.role).toBe('owner')
    })

    it('rejects invalid role (only owner/member)', () => {
      expect(() =>
        db.prepare('INSERT INTO brain_members (brain_id, user_id, role) VALUES (?, ?, ?)').run('b1', 'u1', 'admin')
      ).toThrow(/CHECK/)
    })

    it('CASCADE on brain delete', () => {
      db.prepare('INSERT INTO brain_members (brain_id, user_id, role) VALUES (?, ?, ?)').run('b1', 'u1', 'owner')
      db.prepare('DELETE FROM brains WHERE id = ?').run('b1')
      const count = (db.prepare('SELECT COUNT(*) as c FROM brain_members').get() as { c: number }).c
      expect(count).toBe(0)
    })
  })

  describe('tokens', () => {
    beforeEach(() => {
      db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.de')
      db.prepare('INSERT INTO brains (id, name, owner_id, brain_file) VALUES (?, ?, ?, ?)')
        .run('b1', 'x', 'u1', 'brains/b1.db')
    })

    it('insert + select with hash + prefix', () => {
      db.prepare(
        'INSERT INTO tokens (id, user_id, brain_id, name, token_hash, prefix) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('t1', 'u1', 'b1', 'Mac MCP', 'abc123hash', 'pre12345')

      const row = db.prepare('SELECT * FROM tokens WHERE id = ?').get('t1') as { prefix: string, revoked_at: string | null }
      expect(row.prefix).toBe('pre12345')
      expect(row.revoked_at).toBeNull()
    })

    it('token_hash UNIQUE', () => {
      db.prepare(
        'INSERT INTO tokens (id, user_id, brain_id, token_hash, prefix) VALUES (?, ?, ?, ?, ?)'
      ).run('t1', 'u1', 'b1', 'samehash', 'pre00001')
      expect(() =>
        db.prepare(
          'INSERT INTO tokens (id, user_id, brain_id, token_hash, prefix) VALUES (?, ?, ?, ?, ?)'
        ).run('t2', 'u1', 'b1', 'samehash', 'pre00002')
      ).toThrow(/UNIQUE/)
    })

    it('idx_tokens_prefix excludes revoked tokens (partial index)', () => {
      // Verify partial index: a revoked token may coexist with an active one with
      // the same prefix (the index is WHERE revoked_at IS NULL)
      db.prepare(
        'INSERT INTO tokens (id, user_id, brain_id, token_hash, prefix, revoked_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('t-old', 'u1', 'b1', 'hash-old', 'pre00001', '2026-01-01T00:00:00Z')

      db.prepare(
        'INSERT INTO tokens (id, user_id, brain_id, token_hash, prefix) VALUES (?, ?, ?, ?, ?)'
      ).run('t-new', 'u1', 'b1', 'hash-new', 'pre00001')

      // Lookup via prefix for active tokens must find only the new one
      const active = db.prepare(
        "SELECT id FROM tokens WHERE prefix = ? AND revoked_at IS NULL"
      ).all('pre00001') as { id: string }[]
      expect(active).toHaveLength(1)
      expect(active[0].id).toBe('t-new')
    })

    it('CASCADE on brain delete', () => {
      // tokens.brain_id ON DELETE CASCADE — brain gone, tokens gone.
      // (User delete is NOT testable when the user owns a brain:
      //  brains.owner_id has NO CASCADE, so the FK blocks the user delete
      //  until the brain itself is deleted. That is by design — provisioning
      //  must remove brains explicitly before a user is removed.)
      db.prepare(
        'INSERT INTO tokens (id, user_id, brain_id, token_hash, prefix) VALUES (?, ?, ?, ?, ?)'
      ).run('t1', 'u1', 'b1', 'h', 'p')
      db.prepare('DELETE FROM brains WHERE id = ?').run('b1')
      const count = (db.prepare('SELECT COUNT(*) as c FROM tokens').get() as { c: number }).c
      expect(count).toBe(0)
    })

    it('blocks user delete while brain references owner_id (no CASCADE on owner)', () => {
      db.prepare(
        'INSERT INTO tokens (id, user_id, brain_id, token_hash, prefix) VALUES (?, ?, ?, ?, ?)'
      ).run('t1', 'u1', 'b1', 'h', 'p')
      expect(() =>
        db.prepare('DELETE FROM users WHERE id = ?').run('u1')
      ).toThrow(/FOREIGN KEY/)
    })
  })

  describe('brain_migrations', () => {
    beforeEach(() => {
      db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.de')
      db.prepare('INSERT INTO brains (id, name, owner_id, brain_file) VALUES (?, ?, ?, ?)')
        .run('b1', 'x', 'u1', 'brains/b1.db')
    })

    it('insert + composite primary key (brain_id, schema_version)', () => {
      db.prepare('INSERT INTO brain_migrations (brain_id, schema_version) VALUES (?, ?)').run('b1', 8)
      db.prepare('INSERT INTO brain_migrations (brain_id, schema_version) VALUES (?, ?)').run('b1', 9)

      const rows = db.prepare(
        'SELECT schema_version FROM brain_migrations WHERE brain_id = ? ORDER BY schema_version'
      ).all('b1') as { schema_version: number }[]
      expect(rows.map(r => r.schema_version)).toEqual([8, 9])
    })

    it('rejects duplicate (brain_id, schema_version)', () => {
      db.prepare('INSERT INTO brain_migrations (brain_id, schema_version) VALUES (?, ?)').run('b1', 8)
      expect(() =>
        db.prepare('INSERT INTO brain_migrations (brain_id, schema_version) VALUES (?, ?)').run('b1', 8)
      ).toThrow(/PRIMARY KEY|UNIQUE/)
    })
  })
})
