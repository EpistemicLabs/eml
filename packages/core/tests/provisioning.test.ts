import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { initControlDatabase, CURRENT_BRAIN_SCHEMA_VERSION } from '../src/control'
import { verifyToken } from '../src/tokens'
import { provisionUser } from '../src/provisioning'
import { EML } from '../src'

describe('provisionUser', () => {
  let control: Database.Database
  let dataDir: string

  beforeEach(() => {
    control = initControlDatabase(':memory:')
    dataDir = mkdtempSync(join(tmpdir(), 'eml-provision-test-'))
  })

  afterEach(() => {
    control.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  describe('happy path', () => {
    it('returns userId, brainId, brainFile, tokenId, tokenPlaintext', () => {
      const result = provisionUser({
        email: 'a@b.de',
        agentId: 'agentx',
        userId: 'userx',
        control,
        dataDir,
      })
      expect(result.userId).toBeTruthy()
      expect(result.brainId).toBeTruthy()
      expect(result.brainFile).toMatch(/^brains\/[0-9a-f-]+\.db$/)
      expect(result.tokenId).toBeTruthy()
      expect(result.tokenPlaintext).toMatch(/^eml_[0-9a-f]{40}$/)
    })

    it('persists user, brain, brain_members, brain_migrations, tokens', () => {
      const result = provisionUser({
        email: 'a@b.de',
        agentId: 'bob',
        userId: 'bob',
        control,
        dataDir,
      })

      const user = control.prepare('SELECT email FROM users WHERE id = ?').get(result.userId) as { email: string }
      expect(user.email).toBe('a@b.de')

      const brain = control.prepare('SELECT * FROM brains WHERE id = ?').get(result.brainId) as {
        name: string, owner_id: string, brain_file: string, schema_version: number, status: string,
      }
      expect(brain.name).toBe('bob')
      expect(brain.owner_id).toBe(result.userId)
      expect(brain.brain_file).toBe(result.brainFile)
      expect(brain.schema_version).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
      expect(brain.status).toBe('ok')

      const member = control.prepare('SELECT role FROM brain_members WHERE brain_id = ? AND user_id = ?')
        .get(result.brainId, result.userId) as { role: string }
      expect(member.role).toBe('owner')

      const migration = control.prepare('SELECT schema_version FROM brain_migrations WHERE brain_id = ?')
        .get(result.brainId) as { schema_version: number }
      expect(migration.schema_version).toBe(CURRENT_BRAIN_SCHEMA_VERSION)

      const token = control.prepare('SELECT user_id, brain_id, name, revoked_at FROM tokens WHERE id = ?')
        .get(result.tokenId) as { user_id: string, brain_id: string, name: string, revoked_at: string | null }
      expect(token.user_id).toBe(result.userId)
      expect(token.brain_id).toBe(result.brainId)
      expect(token.name).toBe('bootstrap')
      expect(token.revoked_at).toBeNull()
    })

    it('brains.name is set to agentId', () => {
      const result = provisionUser({ email: 'bob@example.com', agentId: 'helper', userId: 'bob', control, dataDir })
      const brain = control.prepare('SELECT name FROM brains WHERE id = ?').get(result.brainId) as { name: string }
      expect(brain.name).toBe('helper')
    })

    it('returned token verifies against the control plane', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'a', control, dataDir })
      const verified = verifyToken(control, result.tokenPlaintext)
      expect(verified).toEqual({
        tokenId: result.tokenId,
        userId: result.userId,
        brainId: result.brainId,
        caller: 'bootstrap', // default token name from provisionUser
      })
    })

    it('brain file exists + contains default engrams (2 profiles + 3 rules)', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'assistant', userId: 'alice', control, dataDir })
      const brainPath = join(dataDir, result.brainFile)
      expect(existsSync(brainPath)).toBe(true)

      const eml = new EML({ dbPath: brainPath, namespace: 'assistant' })
      try {
        const engrams = eml.engrams.query({})
        expect(engrams).toHaveLength(5)
        const profiles = engrams.filter(e => e.type === 'profile')
        const rules = engrams.filter(e => e.type === 'rule')
        expect(profiles).toHaveLength(2)
        expect(rules).toHaveLength(3)

        // verify title substitution
        const subjects = engrams.map(e => e.title)
        expect(subjects).toContain('assistant-identity')
        expect(subjects).toContain('alice-identity')
        expect(subjects).toContain('assistant-reasoning-discipline')
        expect(subjects).toContain('assistant-engagement-style')
        expect(subjects).toContain('assistant-action-protocol')

        // verify scope substitution
        expect(engrams.find(e => e.title === 'assistant-identity')?.scope).toBe('agent.assistant')
        expect(engrams.find(e => e.title === 'alice-identity')?.scope).toBe('user.alice')

        // agent + user records created
        expect(eml.agents.exists('assistant')).toBe(true)
        expect(eml.users.exists('alice')).toBe(true)
      } finally {
        eml.close()
      }
    })
  })

  describe('email reuse', () => {
    it('second provision for the same email → reuses user, new brain + new token', () => {
      const a = provisionUser({ email: 'a@b.de', agentId: 'a1', userId: 'u1', control, dataDir })
      const b = provisionUser({ email: 'a@b.de', agentId: 'a2', userId: 'u1', control, dataDir })

      expect(b.userId).toBe(a.userId)               // same user
      expect(b.brainId).not.toBe(a.brainId)         // different brain
      expect(b.tokenId).not.toBe(a.tokenId)         // different token
      expect(b.tokenPlaintext).not.toBe(a.tokenPlaintext)

      const userCount = (control.prepare('SELECT COUNT(*) as c FROM users WHERE email = ?')
        .get('a@b.de') as { c: number }).c
      expect(userCount).toBe(1)

      const brainCount = (control.prepare('SELECT COUNT(*) as c FROM brains WHERE owner_id = ?')
        .get(a.userId) as { c: number }).c
      expect(brainCount).toBe(2)
    })
  })

  describe('rollback on failure', () => {
    it('step 2 failure (e.g. brain_file UNIQUE collision) → no control state, brain file removed', () => {
      // Pre-seeding a brains row with a brain_file that would collide with the
      // generated file doesn't work directly (UUID).
      // Simulating the failure instead by creating a user with the same
      // brain_file (the relative path is UNIQUE) so that provisionUser then hits
      // a path conflict: trick — we don't spy, but provoke the failure via a
      // double call with the same brainId. Hard without DI.
      //
      // Alternative: a direct test — we check that when step 2 throws
      // (e.g. when the control DB was already closed before the call), the
      // brain file gets cleaned up.
      //
      // We use the "control DB closed" variant:
      const result = provisionUser({ email: 'a@b.de', agentId: 'a', userId: 'u', control, dataDir })
      const brainPathOk = join(dataDir, result.brainFile)
      expect(existsSync(brainPathOk)).toBe(true)

      // Close the control DB → the next provisionUser call throws in step 2
      control.close()
      let errorCaught: Error | null = null
      try {
        provisionUser({ email: 'b@c.de', agentId: 'b', userId: 'u2', control, dataDir })
      } catch (err) {
        errorCaught = err as Error
      }
      expect(errorCaught).not.toBeNull()

      // No extra brain file should be left over
      // besides the one from the first successful provisioning.
      // We use findBrains via glob:
      const brainsDir = join(dataDir, 'brains')
      const remaining = require('fs').readdirSync(brainsDir).filter((f: string) => f.endsWith('.db'))
      // Only the brain file from the first successful call may remain.
      // (better-sqlite3 sometimes still creates -wal/-shm files — we filter those out.)
      expect(remaining).toHaveLength(1)

      // Re-init so the afterEach cleanup is safe
      control = initControlDatabase(':memory:')
    })
  })
})
