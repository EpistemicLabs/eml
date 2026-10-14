import Database from 'better-sqlite3'
import path from 'path'

/**
 * LRU connection pool for brain DBs.
 *
 * v0.9 hosting assumption (see process-model engram cae1a524):
 *   - Single Node process, ~50-1000 brains expected, "active working set" ≈ 50
 *   - Cap default 50 (env EML_POOL_CAP), 15min idle eviction (EML_POOL_IDLE_TIMEOUT_MIN)
 *   - WAL mode + foreign_keys ON on every open
 *   - When the cap is reached: close the oldest entry + open the new one
 *
 * Map insertion order is stable and guaranteed by the spec — we use it for LRU:
 *   acquire() on a hit re-inserts (delete + set) → the entry moves to the end.
 *   Eviction takes entries.keys().next().value (= the oldest).
 *
 * There is no "release" — better-sqlite3 is sync, no borrow pattern.
 * The pool is a cache of open handles, not a semaphore-bounded borrow pool.
 */

export interface PoolOptions {
  dataDir: string                   // absolute base path; brain_file (relative) is resolved against it
  cap?: number                      // default 50
  idleTimeoutMs?: number            // default 15min
  sweepIntervalMs?: number          // default 60s
}

interface PoolEntry {
  brainId: string
  db: Database.Database
  lastUsedAt: number
}

export class ConnectionPool {
  private entries = new Map<string, PoolEntry>()
  private readonly cap: number
  private readonly idleTimeoutMs: number
  private readonly sweepIntervalMs: number
  private readonly dataDir: string
  private sweepTimer: NodeJS.Timeout | null = null

  constructor(opts: PoolOptions) {
    this.cap = opts.cap ?? 50
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 15 * 60 * 1000
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60 * 1000
    this.dataDir = opts.dataDir
  }

  acquire(brainId: string, brainFile: string): Database.Database {
    const existing = this.entries.get(brainId)
    if (existing) {
      this.entries.delete(brainId)
      existing.lastUsedAt = Date.now()
      this.entries.set(brainId, existing)
      return existing.db
    }

    if (this.entries.size >= this.cap) {
      const oldestId = this.entries.keys().next().value
      if (oldestId !== undefined) this.evict(oldestId)
    }

    const fullPath = path.isAbsolute(brainFile)
      ? brainFile
      : path.join(this.dataDir, brainFile)
    // v0.10.10 C3: fail closed if a registered brain's file is missing. Without
    // fileMustExist, better-sqlite3 silently creates an empty schemaless DB —
    // masking data loss and routing writes into a phantom brain. SQLITE_CANTOPEN
    // is mapped to 503 + needs_intervention upstream (routing.ts).
    const db = new Database(fullPath, { fileMustExist: true })
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    this.entries.set(brainId, { brainId, db, lastUsedAt: Date.now() })
    return db
  }

  has(brainId: string): boolean {
    return this.entries.has(brainId)
  }

  size(): number {
    return this.entries.size
  }

  evict(brainId: string): boolean {
    const entry = this.entries.get(brainId)
    if (!entry) return false
    try { entry.db.close() } catch { /* already closed */ }
    this.entries.delete(brainId)
    return true
  }

  /**
   * Iterates pool entries and closes those unused for longer than idleTimeoutMs.
   * Returns: list of evicted brainIds (for inspection in tests / logging).
   */
  sweepIdle(now: number = Date.now()): string[] {
    const evicted: string[] = []
    for (const [id, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.idleTimeoutMs) {
        this.evict(id)
        evicted.push(id)
      }
    }
    return evicted
  }

  startIdleSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweepIdle(), this.sweepIntervalMs)
    if (this.sweepTimer.unref) this.sweepTimer.unref()
  }

  stopIdleSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  close(): void {
    this.stopIdleSweep()
    for (const id of [...this.entries.keys()]) {
      this.evict(id)
    }
  }

  /** Test helper: sets lastUsedAt for an entry. NOT for production code. */
  _testSetLastUsed(brainId: string, ts: number): void {
    const entry = this.entries.get(brainId)
    if (entry) entry.lastUsedAt = ts
  }
}
