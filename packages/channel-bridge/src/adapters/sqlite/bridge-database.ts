import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL,
  channel_message_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  sender TEXT NOT NULL,
  sender_key TEXT NOT NULL,
  sender_verified INTEGER NOT NULL,
  automated INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  routing TEXT NOT NULL,
  job_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  UNIQUE (channel, account_id, channel_message_id)
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (account_id, thread_key);
CREATE INDEX IF NOT EXISTS messages_job_sender ON messages (job_id, sender_key);

CREATE TABLE IF NOT EXISTS cursors (
  account_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wake_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  space TEXT NOT NULL,
  entry TEXT NOT NULL,
  at TEXT NOT NULL,
  dead INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS wake_entries_job ON wake_entries (job_id, dead, seq);

CREATE TABLE IF NOT EXISTS wake_retries (
  job_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  retry_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  thread_key TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  channel_message_id TEXT,
  failure TEXT,
  UNIQUE (job_id, idempotency_key)
);
`

/** Opens the bridge's own database; the bridge is its only reader and writer. */
export function openBridgeDatabase(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}
