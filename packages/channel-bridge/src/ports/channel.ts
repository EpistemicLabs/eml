import type { Channel } from '../domain/address'
import type { InboundMessage } from '../domain/inbound-message'

export interface OutgoingMessage {
  to: string
  threadKey: string | null
  subject: string | null
  text: string
  /** The channel uses it to recognise a retry of the same send. */
  idempotencyKey: string
}

export type SendOutcome =
  | { kind: 'sent'; channelMessageId: string }
  | { kind: 'failed'; reason: string; retryable: boolean }

export interface SyncResult {
  messages: InboundMessage[]
  /** Where the next sync goes on from. */
  cursor: string
}

/** One account on one channel: a mailbox, later a number or a workspace. */
export interface ChannelAccount {
  readonly channel: Channel
  readonly accountId: string
  /** The agent space the account belongs to. */
  readonly space: string
  /** Messages since the cursor; null starts from now. */
  sync(cursor: string | null): Promise<SyncResult>
  send(message: OutgoingMessage): Promise<SendOutcome>
}

export interface ChannelAccounts {
  account(accountId: string): ChannelAccount | null
}
