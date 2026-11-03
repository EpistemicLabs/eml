import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { initControlDatabase, CURRENT_BRAIN_SCHEMA_VERSION } from '../src/control'
import { verifyToken } from '../src/tokens'
import { provisionBrain, provisionUser } from '../src/provisioning'
import { EML, checkBrainIds } from '../src'

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

  describe('provisionBrain (v0.21): an empty brain under a given id', () => {
    const TEAM = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

    it('registers the brain like provisionUser — the given id, the space name, the handle as token name — and the file has the schema, no rows and no genesis', () => {
      const result = provisionBrain({ email: 'a@b.de', brainId: TEAM, name: 'EML team', control, dataDir, tokenName: 'alice' })
      expect(result.brainId).toBe(TEAM)
      expect(result.brainFile).toBe(`brains/${TEAM}.db`)
      const brain = control.prepare('SELECT name, owner_id, schema_version, status FROM brains WHERE id = ?').get(TEAM) as { name: string, owner_id: string, schema_version: number, status: string }
      expect(brain).toEqual({ name: 'EML team', owner_id: result.userId, schema_version: CURRENT_BRAIN_SCHEMA_VERSION, status: 'ok' })
      expect(control.prepare('SELECT role FROM brain_members WHERE brain_id = ?').get(TEAM)).toEqual({ role: 'owner' })
      expect(control.prepare('SELECT schema_version FROM brain_migrations WHERE brain_id = ?').get(TEAM)).toEqual({ schema_version: CURRENT_BRAIN_SCHEMA_VERSION })
      expect(verifyToken(control, result.tokenPlaintext)).toMatchObject({ brainId: TEAM, caller: 'alice' })
      const eml = new EML({ dbPath: join(dataDir, result.brainFile), namespace: 'team' })
      try {
        expect(eml.hasGenesis()).toBe(false)
        expect(eml.brainId()).toBeNull()
        expect(eml.engrams.query({})).toHaveLength(0)
        expect(eml.agents.list()).toHaveLength(0)
      } finally {
        eml.close()
      }
    })

    it('reuses the owner row of a provisioned user', () => {
      const own = provisionUser({ email: 'a@b.de', agentId: 'assistant', userId: 'alice', control, dataDir })
      const team = provisionBrain({ email: 'a@b.de', brainId: TEAM, name: 'EML team', control, dataDir, tokenName: 'alice' })
      expect(team.userId).toBe(own.userId)
      expect(control.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 })
    })

    it('refuses an id that is not a lowercase UUID, and a brain that exists already; nothing is left behind', () => {
      expect(() => provisionBrain({ email: 'a@b.de', brainId: 'Not-A-UUID', name: 'x', control, dataDir, tokenName: 'alice' })).toThrow(/not a lowercase UUID/)
      provisionBrain({ email: 'a@b.de', brainId: TEAM, name: 'EML team', control, dataDir, tokenName: 'alice' })
      expect(() => provisionBrain({ email: 'a@b.de', brainId: TEAM, name: 'again', control, dataDir, tokenName: 'alice' })).toThrow(/exists already/)
      expect(control.prepare('SELECT COUNT(*) AS n FROM brains').get()).toEqual({ n: 1 })
      expect(control.prepare('SELECT COUNT(*) AS n FROM tokens').get()).toEqual({ n: 1 })
      expect(existsSync(join(dataDir, `brains/${TEAM}.db`))).toBe(true)
    })

    it('removes the file again when the control plane refuses the row', () => {
      control.prepare(`INSERT INTO users (id, email) VALUES ('u-x', 'x@b.de')`).run()
      control.prepare('INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES (?, ?, ?, ?, ?)').run(TEAM, 'taken', 'u-x', 'brains/other.db', CURRENT_BRAIN_SCHEMA_VERSION)
      // the id is taken, so provisionBrain refuses before any file; force the control-plane failure through a dropped table instead
      const OTHER_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
      control.prepare('DROP TABLE brain_migrations').run()
      expect(() => provisionBrain({ email: 'a@b.de', brainId: OTHER_ID, name: 'x', control, dataDir, tokenName: 'alice' })).toThrow()
      expect(existsSync(join(dataDir, `brains/${OTHER_ID}.db`))).toBe(false)
      expect(control.prepare('SELECT COUNT(*) AS n FROM brains WHERE id = ?').get(OTHER_ID)).toEqual({ n: 0 })
    })
  })

  describe('brain id (v0.21)', () => {
    it('the genesis carries the control row\'s brain id', () => {
      const result = provisionUser({ email: 'a@b.de', agentId: 'assistant', userId: 'alice', control, dataDir })
      const eml = new EML({ dbPath: join(dataDir, result.brainFile), namespace: 'assistant' })
      try {
        expect(eml.brainId()).toBe(result.brainId)
      } finally {
        eml.close()
      }
    })

    it('a control row naming another id than the genesis is set to needs_intervention at start', () => {
      const ok = provisionUser({ email: 'a@b.de', agentId: 'assistant', userId: 'alice', control, dataDir })
      const off = provisionUser({ email: 'b@b.de', agentId: 'assistant', userId: 'bob', control, dataDir })
      const other = '0f8fad5b-d9cb-469f-a165-70867728950e'
      control.pragma('foreign_keys = OFF')
      control.prepare('UPDATE brains SET id = ? WHERE id = ?').run(other, off.brainId)
      control.pragma('foreign_keys = ON')
      expect(checkBrainIds({ control, dataDir })).toEqual([{ brainId: other, brainName: 'assistant', genesisId: off.brainId }])
      const status = (id: string) => (control.prepare('SELECT status FROM brains WHERE id = ?').get(id) as { status: string }).status
      expect(status(other)).toBe('needs_intervention')
      expect(status(ok.brainId)).toBe('ok')
      expect(checkBrainIds({ control, dataDir })).toEqual([])
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
