import type { Channel } from '../../domain/address'
import type { InboundMessage } from '../../domain/inbound-message'
import type { ChannelAccount, ChannelAccounts, ChannelUnavailable, OutgoingMessage, SendOutcome, SyncResult } from '../../ports/channel'

/**
 * A channel account that lives in memory: a test or a scripted conversation puts messages in,
 * and sync hands them out after the cursor, the way a real channel's history does. Sends are
 * recorded; the same idempotency key twice is sent once.
 */
export class ScriptedChannel implements ChannelAccount {
  readonly channel: Channel = 'mail'
  readonly sent: OutgoingMessage[] = []
  private readonly history: InboundMessage[] = []
  private refuseWith: { reason: string; retryable: boolean } | null = null
  private down: ChannelUnavailable | null = null
  private historyLost = false

  constructor(
    readonly accountId: string,
    readonly space: string,
  ) {}

  receive(message: Omit<InboundMessage, 'channel' | 'accountId'>): void {
    this.history.push({ ...message, channel: this.channel, accountId: this.accountId })
  }

  refuseSends(reason: string, retryable: boolean): void {
    this.refuseWith = { reason, retryable }
  }

  acceptSends(): void {
    this.refuseWith = null
  }

  unavailable(reason: ChannelUnavailable['reason'], retryable: boolean): void {
    this.down = { kind: 'unavailable', reason, retryable }
  }

  /** The next sync cannot go on from its cursor, as when a channel's history has expired. */
  loseHistory(): void {
    this.historyLost = true
  }

  async sync(cursor: string | null): Promise<SyncResult> {
    if (this.down) return this.down
    if (this.historyLost) {
      this.historyLost = false
      return { kind: 'synced', messages: [], cursor: String(this.history.length), gap: true }
    }
    const from = cursor === null ? this.history.length : Number(cursor)
    return { kind: 'synced', messages: this.history.slice(from), cursor: String(this.history.length), gap: false }
  }

  async send(message: OutgoingMessage): Promise<SendOutcome> {
    if (this.refuseWith) return { kind: 'failed', ...this.refuseWith }
    const earlier = this.sent.findIndex((sent) => sent.idempotencyKey === message.idempotencyKey)
    if (earlier >= 0) return { kind: 'sent', channelMessageId: `sent-${earlier + 1}` }
    this.sent.push(message)
    return { kind: 'sent', channelMessageId: `sent-${this.sent.length}` }
  }
}

export class ScriptedChannels implements ChannelAccounts {
  constructor(private readonly accounts: ChannelAccount[]) {}

  account(accountId: string): ChannelAccount | null {
    return this.accounts.find((account) => account.accountId === accountId) ?? null
  }

  inSpace(space: string): ChannelAccount[] {
    return this.accounts.filter((account) => account.space === space)
  }
}
