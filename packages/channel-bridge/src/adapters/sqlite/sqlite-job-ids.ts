import type Database from 'better-sqlite3'
import type { JobIds, JobRenamed, RenameClash } from '../../ports/job-ids'

/** Renames a job in every table of the bridge's database that names one, in one transaction. */
export class SqliteJobIds implements JobIds {
  constructor(private readonly db: Database.Database) {}

  async rename(from: string, to: string): Promise<JobRenamed> {
    return this.db.transaction((): JobRenamed => {
      // A message's job is in its column and in its stored routing: both, or its thread would stay with the old id.
      const messages = this.db
        .prepare("UPDATE messages SET job_id = ?, routing = json_set(routing, '$.jobId', ?) WHERE job_id = ?")
        .run(to, to, from).changes
      // OR IGNORE: a row that would break a unique key stays under the old id, and is named below.
      const wakeEntries = this.db.prepare('UPDATE OR IGNORE wake_entries SET job_id = ? WHERE job_id = ?').run(to, from).changes
      // A retry state is one row per job. When both ids have one (two jobs merged onto one task), the one that
      // comes due earlier is kept under the new id and the other goes: no retry is left under an id nothing asks for.
      const earlier = this.db
        .prepare('SELECT 1 FROM wake_retries old JOIN wake_retries new ON new.job_id = ? WHERE old.job_id = ? AND old.retry_at < new.retry_at')
        .get(to, from) !== undefined
      this.db.prepare('DELETE FROM wake_retries WHERE job_id = ? AND EXISTS (SELECT 1 FROM wake_retries WHERE job_id = ?)').run(earlier ? to : from, earlier ? from : to)
      const wakeRetries = this.db.prepare('UPDATE wake_retries SET job_id = ? WHERE job_id = ?').run(to, from).changes
      const outbox = this.db.prepare('UPDATE OR IGNORE outbox SET job_id = ? WHERE job_id = ?').run(to, from).changes
      const left = (sql: string) => (this.db.prepare(sql).all(from) as { key: string }[]).map((row) => row.key)
      const clashes: RenameClash[] = [
        ...left('SELECT entry_key AS key FROM wake_entries WHERE job_id = ? AND dead = 0 ORDER BY seq').map((key) => ({ store: 'wake_entries' as const, key })),
        ...left('SELECT idempotency_key AS key FROM outbox WHERE job_id = ? ORDER BY rowid').map((key) => ({ store: 'outbox' as const, key })),
      ]
      return { messages, wakeEntries, wakeRetries, outbox, clashes }
    })()
  }
}
