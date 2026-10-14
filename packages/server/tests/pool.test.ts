import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { ConnectionPool } from '../src/pool'

// v0.10.10 C3: the pool now opens brain files with { fileMustExist: true } — a
// registered brain whose file is missing must throw, not silently materialize an
// empty phantom DB. Existing tests therefore seed a real file before acquiring.
function seed(dir: string, file: string): void {
  const d = new Database(join(dir, file))
  d.exec('CREATE TABLE IF NOT EXISTS _seed (x)')
  d.close()
}

describe('ConnectionPool', () => {
  let dataDir: string
  let pool: ConnectionPool

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'eml-pool-test-'))
    for (const f of ['b1.db', 'b2.db', 'b3.db', 'abs.db']) seed(dataDir, f)
  })

  afterEach(() => {
    if (pool) pool.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  describe('acquire', () => {
    it('opens connection on miss, caches on hit', () => {
      pool = new ConnectionPool({ dataDir, cap: 5 })
      const a1 = pool.acquire('b1', 'b1.db')
      expect(pool.size()).toBe(1)
      expect(pool.has('b1')).toBe(true)

      const a2 = pool.acquire('b1', 'b1.db')
      expect(a2).toBe(a1)         // same instance
      expect(pool.size()).toBe(1)
    })

    it('opens with WAL mode + foreign_keys ON', () => {
      pool = new ConnectionPool({ dataDir, cap: 5 })
      const db = pool.acquire('b1', 'b1.db')
      const journal = (db.pragma('journal_mode', { simple: true }) as string).toLowerCase()
      expect(journal).toBe('wal')
      const fk = db.pragma('foreign_keys', { simple: true })
      expect(fk).toBe(1)
    })

    it('grows up to cap', () => {
      pool = new ConnectionPool({ dataDir, cap: 3 })
      pool.acquire('b1', 'b1.db')
      pool.acquire('b2', 'b2.db')
      pool.acquire('b3', 'b3.db')
      expect(pool.size()).toBe(3)
    })

    it('evicts oldest when cap reached', () => {
      pool = new ConnectionPool({ dataDir, cap: 2 })
      pool.acquire('b1', 'b1.db')
      pool.acquire('b2', 'b2.db')
      pool.acquire('b3', 'b3.db')
      expect(pool.size()).toBe(2)
      expect(pool.has('b1')).toBe(false)
      expect(pool.has('b2')).toBe(true)
      expect(pool.has('b3')).toBe(true)
    })

    it('LRU bump-to-top: re-acquired entry survives next eviction', () => {
      pool = new ConnectionPool({ dataDir, cap: 2 })
      pool.acquire('b1', 'b1.db')
      pool.acquire('b2', 'b2.db')
      pool.acquire('b1', 'b1.db')   // bump b1 to top → b2 becomes oldest
      pool.acquire('b3', 'b3.db')   // evicts b2 (oldest), not b1
      expect(pool.has('b1')).toBe(true)
      expect(pool.has('b2')).toBe(false)
      expect(pool.has('b3')).toBe(true)
    })

    it('accepts absolute paths (path.isAbsolute branch)', () => {
      pool = new ConnectionPool({ dataDir: '/some/other/dir', cap: 5 })
      const absPath = join(dataDir, 'abs.db')
      const db = pool.acquire('b-abs', absPath)
      expect(db).toBeDefined()
      expect(pool.has('b-abs')).toBe(true)
    })

    it('missing brain file → throws SQLITE_CANTOPEN, creates no phantom DB (v0.10.10 C3)', () => {
      pool = new ConnectionPool({ dataDir, cap: 5 })
      let code: string | undefined
      try {
        pool.acquire('ghost', 'ghost.db')
      } catch (err) {
        code = (err as { code?: string }).code
      }
      expect(code).toBe('SQLITE_CANTOPEN')
      expect(existsSync(join(dataDir, 'ghost.db'))).toBe(false)   // not silently materialized
      expect(pool.has('ghost')).toBe(false)                       // not cached
    })
  })

  describe('idle eviction', () => {
    it('sweepIdle evicts entries past idleTimeoutMs', () => {
      pool = new ConnectionPool({ dataDir, cap: 5, idleTimeoutMs: 1000 })
      pool.acquire('b1', 'b1.db')
      pool.acquire('b2', 'b2.db')

      // Backdate b1 only
      pool._testSetLastUsed('b1', Date.now() - 5000)

      const evicted = pool.sweepIdle()
      expect(evicted).toEqual(['b1'])
      expect(pool.has('b1')).toBe(false)
      expect(pool.has('b2')).toBe(true)
    })

    it('sweepIdle no-op when nothing past idle', () => {
      pool = new ConnectionPool({ dataDir, cap: 5, idleTimeoutMs: 60_000 })
      pool.acquire('b1', 'b1.db')
      const evicted = pool.sweepIdle()
      expect(evicted).toEqual([])
      expect(pool.size()).toBe(1)
    })

    it('startIdleSweep + stopIdleSweep are idempotent', () => {
      pool = new ConnectionPool({ dataDir, cap: 5 })
      pool.startIdleSweep()
      pool.startIdleSweep()  // no-op
      pool.stopIdleSweep()
      pool.stopIdleSweep()   // no-op
    })
  })

  describe('close', () => {
    it('closes all open connections + clears map', () => {
      pool = new ConnectionPool({ dataDir, cap: 5 })
      pool.acquire('b1', 'b1.db')
      pool.acquire('b2', 'b2.db')
      pool.close()
      expect(pool.size()).toBe(0)
    })
  })

  describe('evict', () => {
    it('returns true on hit, false on miss', () => {
      pool = new ConnectionPool({ dataDir, cap: 5 })
      pool.acquire('b1', 'b1.db')
      expect(pool.evict('b1')).toBe(true)
      expect(pool.evict('b1')).toBe(false)
      expect(pool.evict('never-existed')).toBe(false)
    })
  })
})
