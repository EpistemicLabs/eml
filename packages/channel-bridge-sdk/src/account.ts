import type { Channel } from './address'
import type { InboundMessage } from './inbound-message'

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

/** The channel cannot be read or written now; whether asking again can help. */
export interface ChannelUnavailable {
  kind: 'unavailable'
  reason: 'access_revoked' | 'unreachable' | 'rate_limited' | 'bad_answer'
  retryable: boolean
}

export type SyncResult =
  | {
      kind: 'synced'
      messages: InboundMessage[]
      /** Where the next sync goes on from. */
      cursor: string
      /** The channel could not go on from the cursor and started again from now; messages between may be missing. */
      gap: boolean
    }
  | ChannelUnavailable

/** One account on one channel: a mailbox, later a number or a workspace. */
export interface ChannelAccount {
  readonly channel: Channel
  readonly accountId: string
  /**
   * The agent spaces where its plugin is on. There is no home space: a message is routed among the
   * jobs of all of them, and one no job takes waits in the inbox of each.
   */
  readonly spaces: readonly string[]
  /** Messages since the cursor; null starts from now. */
  sync(cursor: string | null): Promise<SyncResult>
  send(message: OutgoingMessage): Promise<SendOutcome>
}
