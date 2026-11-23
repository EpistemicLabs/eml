import type { ChannelAccount } from '@engramprotocol/channel-bridge-sdk'

// A channel account is what a plugin's channel part implements (packages/channel-bridge-sdk).
export type { ChannelAccount, ChannelUnavailable, OutgoingMessage, SendOutcome, SyncResult } from '@engramprotocol/channel-bridge-sdk'

export interface ChannelAccounts {
  account(accountId: string): ChannelAccount | null
  /** The accounts of one space. */
  inSpace(space: string): ChannelAccount[]
}
