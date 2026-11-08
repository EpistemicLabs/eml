import type Database from 'better-sqlite3'
import type { OutboxItem, OutboxState } from '../../domain/outbox'
import type { OutboxStore } from '../../ports/outbox-store'
import { parseChannel, parseOutboxState } from './stored-shapes'

interface OutboxRow {
  id: string
  job_id: string
  channel: string
  account_id: string
  recipient: string
  thread_key: string | null
  subject: string | null
  body: string
  idempotency_key: string
  state: string
  channel_message_id: string | null
  failure: string | null
}

export class SqliteOutboxStore implements OutboxStore {
  constructor(private readonly db: Database.Database) {}

  async add(item: OutboxItem): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO outbox (id, job_id, channel, account_id, recipient, thread_key, subject, body,
           idempotency_key, state, channel_message_id, failure)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id, item.jobId, item.channel, item.accountId, item.to, item.threadKey, item.subject, item.text,
        item.idempotencyKey, item.state, item.channelMessageId, item.failure,
      )
  }

  async get(id: string): Promise<OutboxItem | null> {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow | undefined
    return row ? toItem(row) : null
  }

  async byKey(jobId: string, idempotencyKey: string): Promise<OutboxItem | null> {
    const row = this.db.prepare('SELECT * FROM outbox WHERE job_id = ? AND idempotency_key = ?').get(jobId, idempotencyKey) as
      | OutboxRow
      | undefined
    return row ? toItem(row) : null
  }

  async update(item: OutboxItem): Promise<void> {
    this.db
      .prepare('UPDATE outbox SET state = ?, channel_message_id = ?, failure = ? WHERE id = ?')
      .run(item.state, item.channelMessageId, item.failure, item.id)
  }

  async replace(item: OutboxItem, expected: OutboxState): Promise<boolean> {
    const result = this.db
      .prepare('UPDATE outbox SET state = ?, channel_message_id = ?, failure = ? WHERE id = ? AND state = ?')
      .run(item.state, item.channelMessageId, item.failure, item.id, expected)
    return result.changes === 1
  }
}

function toItem(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    jobId: row.job_id,
    channel: parseChannel(row.channel),
    accountId: row.account_id,
    to: row.recipient,
    threadKey: row.thread_key,
    subject: row.subject,
    text: row.body,
    idempotencyKey: row.idempotency_key,
    state: parseOutboxState(row.state),
    channelMessageId: row.channel_message_id,
    failure: row.failure,
  }
}
