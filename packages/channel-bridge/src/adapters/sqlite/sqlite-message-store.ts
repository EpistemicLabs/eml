import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { normalizeMailAddress } from '../../domain/address'
import type { InboundMessage } from '../../domain/inbound-message'
import type { Routing } from '../../domain/routing'
import type { MessageStore, SaveOutcome, StoredMessage } from '../../ports/message-store'
import { parseChannel, parseRouting } from './stored-shapes'

interface MessageRow {
  id: string
  channel: string
  account_id: string
  channel_message_id: string
  thread_key: string
  sender: string
  sender_verified: number
  automated: number
  received_at: string
  subject: string | null
  body: string
  routing: string
}

export class SqliteMessageStore implements MessageStore {
  constructor(private readonly db: Database.Database) {}

  async save(message: InboundMessage, routing: Routing): Promise<SaveOutcome> {
    const id = randomUUID()
    const result = this.db
      .prepare(
        `INSERT INTO messages (id, channel, account_id, channel_message_id, thread_key, sender, sender_key,
           sender_verified, automated, received_at, subject, body, routing, job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel, account_id, channel_message_id) DO NOTHING`,
      )
      .run(
        id,
        message.channel,
        message.accountId,
        message.channelMessageId,
        message.threadKey,
        message.from,
        normalizeMailAddress(message.from),
        message.senderVerified ? 1 : 0,
        message.automated ? 1 : 0,
        message.receivedAt,
        message.subject,
        message.text,
        JSON.stringify(routing),
        routing.kind === 'job' ? routing.jobId : null,
      )
    return result.changes === 0 ? { kind: 'duplicate' } : { kind: 'stored', id }
  }

  async threadOwner(accountId: string, threadKey: string): Promise<string | null> {
    const row = this.db
      .prepare(
        `SELECT job_id FROM messages WHERE account_id = ? AND thread_key = ? AND job_id IS NOT NULL
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(accountId, threadKey) as { job_id: string } | undefined
    return row?.job_id ?? null
  }

  async senderKnownToJob(jobId: string, address: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT 1 FROM messages WHERE job_id = ? AND sender_key = ? LIMIT 1')
      .get(jobId, normalizeMailAddress(address))
    return row !== undefined
  }

  async get(id: string): Promise<StoredMessage | null> {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
    return row ? toStoredMessage(row) : null
  }

  async unreadForJob(jobId: string): Promise<StoredMessage[]> {
    const rows = this.db.prepare('SELECT * FROM messages WHERE job_id = ? AND read = 0 ORDER BY rowid').all(jobId) as MessageRow[]
    return rows.map(toStoredMessage)
  }

  async markRead(ids: string[]): Promise<void> {
    const mark = this.db.prepare('UPDATE messages SET read = 1 WHERE id = ?')
    this.db.transaction(() => {
      for (const id of ids) mark.run(id)
    })()
  }

  async forJob(jobId: string): Promise<StoredMessage[]> {
    const rows = this.db.prepare('SELECT * FROM messages WHERE job_id = ? ORDER BY rowid').all(jobId) as MessageRow[]
    return rows.map(toStoredMessage)
  }

  async cursor(accountId: string): Promise<string | null> {
    const row = this.db.prepare('SELECT cursor FROM cursors WHERE account_id = ?').get(accountId) as
      | { cursor: string }
      | undefined
    return row?.cursor ?? null
  }

  async setCursor(accountId: string, cursor: string): Promise<void> {
    this.db
      .prepare('INSERT INTO cursors (account_id, cursor) VALUES (?, ?) ON CONFLICT (account_id) DO UPDATE SET cursor = excluded.cursor')
      .run(accountId, cursor)
  }
}

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    channel: parseChannel(row.channel),
    accountId: row.account_id,
    channelMessageId: row.channel_message_id,
    threadKey: row.thread_key,
    from: row.sender,
    senderVerified: row.sender_verified === 1,
    automated: row.automated === 1,
    receivedAt: row.received_at,
    subject: row.subject,
    text: row.body,
    routing: parseRouting(row.routing),
  }
}
