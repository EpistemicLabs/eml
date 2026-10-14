import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { initControlDatabase, CURRENT_BRAIN_SCHEMA_VERSION } from '@engramprotocol/core'
import { ConnectionPool } from '../src/pool'
import { route } from '../src/middleware/routing'

// v0.10.10 C3: brains open with { fileMustExist: true }, so a registered brain
// needs a real file on disk to route OK. Seed one; the missing-file case asserts 503.
function seedBrainFile(dir: string, file: string): void {
  const d = new Database(join(dir, file))
  d.exec('CREATE TABLE IF NOT EXISTS _seed (x)')
  d.close()
}

describe('route', () => {
  let control: Database.Database
  let dataDir: string
  let pool: ConnectionPool

  beforeEach(() => {
    control = initControlDatabase(':memory:')
    dataDir = mkdtempSync(join(tmpdir(), 'eml-route-test-'))
    mkdirSync(join(dataDir, 'brains'), { recursive: true })
    pool = new ConnectionPool({ dataDir, cap: 5 })

    control.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.de')
    control.prepare(
      'INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES (?, ?, ?, ?, ?)'
    ).run('b1', 'x', 'u1', 'brains/b1.db', CURRENT_BRAIN_SCHEMA_VERSION)
    seedBrainFile(dataDir, 'brains/b1.db')
  })

  afterEach(() => {
    pool.close()
    control.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('known brain → ok ctx with pooled connection', () => {
    const result = route(control, pool, 'b1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.ctx.brainId).toBe('b1')
      expect(result.ctx.brainName).toBe('x')
      expect(result.ctx.brainFile).toBe('brains/b1.db')
      expect(result.ctx.brainDb).toBeDefined()
    }
    expect(pool.has('b1')).toBe(true)
  })

  it('second route() → reuses pooled connection', () => {
    const a = route(control, pool, 'b1')
    const b = route(control, pool, 'b1')
    if (a.ok && b.ok) {
      expect(b.ctx.brainDb).toBe(a.ctx.brainDb)
    }
    expect(pool.size()).toBe(1)
  })

  it('unknown brain → 404', () => {
    const result = route(control, pool, 'no-such-brain')
    expect(result).toMatchObject({ ok: false, status: 404 })
  })

  it('brain with status=needs_intervention → 503', () => {
    control.prepare('UPDATE brains SET status = ? WHERE id = ?').run('needs_intervention', 'b1')
    const result = route(control, pool, 'b1')
    expect(result).toMatchObject({ ok: false, status: 503 })
  })

  it('registered brain whose data file is missing → 503, not 500 (v0.10.10 C3)', () => {
    control.prepare(
      'INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES (?, ?, ?, ?, ?)'
    ).run('b-missing', 'gone', 'u1', 'brains/missing.db', CURRENT_BRAIN_SCHEMA_VERSION)   // file deliberately not seeded

    const result = route(control, pool, 'b-missing')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(503)
      expect(result.error).toMatch(/needs_intervention/)
    }
    // must NOT have silently created the phantom file
    expect(existsSync(join(dataDir, 'brains/missing.db'))).toBe(false)
  })

  it('brain on an older schema than the code → 503 BRAIN_BEHIND_CODE, no connection opened (v0.14 Cluster 0)', () => {
    control.prepare('UPDATE brains SET schema_version = ? WHERE id = ?')
      .run(CURRENT_BRAIN_SCHEMA_VERSION - 1, 'b1')

    const result = route(control, pool, 'b1')

    expect(result).toMatchObject({ ok: false, status: 503, code: 'BRAIN_BEHIND_CODE' })
    expect(pool.has('b1')).toBe(false)
  })
})
