import { normalizeMailAddress } from '../../domain/address'
import type { InboundMessage } from '../../domain/inbound-message'
import type { Routing } from '../../domain/routing'
import type { MessageStore, SaveOutcome, StoredMessage } from '../../ports/message-store'

export class MemoryMessageStore implements MessageStore {
  private readonly messages: StoredMessage[] = []
  private readonly cursors = new Map<string, string>()
  private nextId = 1

  async save(message: InboundMessage, routing: Routing): Promise<SaveOutcome> {
    const duplicate = this.messages.some(
      (stored) =>
        stored.channel === message.channel &&
        stored.accountId === message.accountId &&
        stored.channelMessageId === message.channelMessageId,
    )
    if (duplicate) return { kind: 'duplicate' }
    const id = `msg-${this.nextId++}`
    this.messages.push({ ...message, id, routing })
    return { kind: 'stored', id }
  }

  async threadOwner(accountId: string, threadKey: string): Promise<string | null> {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const stored = this.messages[i]
      if (stored && stored.accountId === accountId && stored.threadKey === threadKey && stored.routing.kind === 'job') {
        return stored.routing.jobId
      }
    }
    return null
  }

  async senderKnownToJob(jobId: string, address: string): Promise<boolean> {
    const wanted = normalizeMailAddress(address)
    return this.messages.some(
      (stored) => stored.routing.kind === 'job' && stored.routing.jobId === jobId && normalizeMailAddress(stored.from) === wanted,
    )
  }

  async forJob(jobId: string): Promise<StoredMessage[]> {
    return this.messages.filter((stored) => stored.routing.kind === 'job' && stored.routing.jobId === jobId)
  }

  async cursor(accountId: string): Promise<string | null> {
    return this.cursors.get(accountId) ?? null
  }

  async setCursor(accountId: string, cursor: string): Promise<void> {
    this.cursors.set(accountId, cursor)
  }
}
