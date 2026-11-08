import type Database from 'better-sqlite3'
import { pendingWakes } from '../../domain/wake'
import type { PendingWake, WakeEntry, WakeOwner } from '../../domain/wake'
import type { WakeQueue } from '../../ports/wake-queue'
import { parseWakeEntry } from './stored-shapes'

interface EntryRow {
  seq: number
  job_id: string
  space: string
  entry: string
  at: string
}

export class SqliteWakeQueue implements WakeQueue {
  constructor(private readonly db: Database.Database) {}

  async add(owner: WakeOwner, entry: WakeEntry, at: string): Promise<void> {
    this.db
      .prepare('INSERT INTO wake_entries (job_id, space, entry, at) VALUES (?, ?, ?, ?)')
      .run(owner.jobId, owner.space, JSON.stringify(entry), at)
  }

  async pending(): Promise<PendingWake[]> {
    const rows = this.db.prepare('SELECT seq, job_id, space, entry, at FROM wake_entries WHERE dead = 0 ORDER BY seq').all() as EntryRow[]
    const retries = this.db.prepare('SELECT job_id, attempts, retry_at FROM wake_retries').all() as {
      job_id: string
      attempts: number
      retry_at: string
    }[]
    return pendingWakes(
      rows.map((row) => ({ seq: row.seq, jobId: row.job_id, space: row.space, entry: parseWakeEntry(row.entry), at: row.at })),
      new Map(retries.map((retry) => [retry.job_id, { attempts: retry.attempts, retryAt: retry.retry_at }])),
    )
  }

  async delivered(jobId: string, upTo: number): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM wake_entries WHERE job_id = ? AND seq <= ?').run(jobId, upTo)
      this.db.prepare('DELETE FROM wake_retries WHERE job_id = ?').run(jobId)
    })()
  }

  async retryLater(jobId: string, attempts: number, retryAt: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO wake_retries (job_id, attempts, retry_at) VALUES (?, ?, ?)
         ON CONFLICT (job_id) DO UPDATE SET attempts = excluded.attempts, retry_at = excluded.retry_at`,
      )
      .run(jobId, attempts, retryAt)
  }

  async dead(jobId: string, upTo: number): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('UPDATE wake_entries SET dead = 1 WHERE job_id = ? AND seq <= ?').run(jobId, upTo)
      this.db.prepare('DELETE FROM wake_retries WHERE job_id = ?').run(jobId)
    })()
  }
}
