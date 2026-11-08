import type { InboundMessage } from '../domain/inbound-message'
import type { Routing } from '../domain/routing'

export interface StoredMessage extends InboundMessage {
  id: string
  routing: Routing
}

export type SaveOutcome = { kind: 'stored'; id: string } | { kind: 'duplicate' }

export interface MessageStore {
  /** Stores a message once; the same channel message again is a duplicate. */
  save(message: InboundMessage, routing: Routing): Promise<SaveOutcome>
  /** The job the thread's earlier messages went to, or null. */
  threadOwner(accountId: string, threadKey: string): Promise<string | null>
  /** Someone with this address wrote to the job before. */
  senderKnownToJob(jobId: string, address: string): Promise<boolean>
  forJob(jobId: string): Promise<StoredMessage[]>
  cursor(accountId: string): Promise<string | null>
  setCursor(accountId: string, cursor: string): Promise<void>
}
