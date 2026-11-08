import type { InboundMessage } from '../domain/inbound-message'
import type { Routing } from '../domain/routing'

export interface StoredMessage extends InboundMessage {
  id: string
  routing: Routing
  /** The job it went to has read it. */
  read: boolean
}

export type SaveOutcome = { kind: 'stored'; id: string } | { kind: 'duplicate'; id: string }

export interface MessageStore {
  /** Stores a message once; the same channel message again is a duplicate. */
  save(message: InboundMessage, routing: Routing): Promise<SaveOutcome>
  /** The job the thread's earlier messages went to, or null. */
  threadOwner(accountId: string, threadKey: string): Promise<string | null>
  /** Someone with this address wrote to the job before. */
  senderKnownToJob(jobId: string, address: string): Promise<boolean>
  get(id: string): Promise<StoredMessage | null>
  /** The job's messages it has not read yet, oldest first. */
  unreadForJob(jobId: string): Promise<StoredMessage[]>
  markRead(ids: string[]): Promise<void>
  cursor(accountId: string): Promise<string | null>
  setCursor(accountId: string, cursor: string): Promise<void>
}
