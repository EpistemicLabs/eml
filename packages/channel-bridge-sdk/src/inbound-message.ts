import type { Channel } from './address'

/** A message as a channel delivered it, mapped to the bridge's own shape. */
export interface InboundMessage {
  channel: Channel
  /** The bridge account (mailbox, number) it arrived in. */
  accountId: string
  /** The channel's own immutable id: with channel and account, the dedup key. */
  channelMessageId: string
  /** The channel's conversation id, e.g. a mail thread. */
  threadKey: string
  /** The sender's address, as the channel reports it. */
  from: string
  /** The channel vouches for the sender (mail: DKIM or DMARC passed for the sender's domain). */
  senderVerified: boolean
  /** Sent by a machine (bulk, list, auto-reply): it never wakes a job. */
  automated: boolean
  receivedAt: string
  subject: string | null
  /** Untrusted text from outside: shown to a job as data, never as instructions. */
  text: string
}
