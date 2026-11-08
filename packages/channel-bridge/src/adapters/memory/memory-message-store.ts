import { normalizeMailAddress } from '../../domain/address'
import type { InboundMessage } from '../../domain/inbound-message'
import type { Routing } from '../../domain/routing'
import type { MessageStore, SaveOutcome, StoredMessage } from '../../ports/message-store'

export class MemoryMessageStore implements MessageStore {
  private readonly messages: StoredMessage[] = []
  private readonly cursors = new Map<string, string>()
  private readonly read = new Set<string>()
  private nextId = 1

  async save(message: InboundMessage, routing: Routing): Promise<SaveOutcome> {
    const duplicate = this.messages.find(
      (stored) =>
        stored.channel === message.channel &&
        stored.accountId === message.accountId &&
        stored.channelMessageId === message.channelMessageId,
    )
    if (duplicate) return { kind: 'duplicate', id: duplicate.id }
    const id = `msg-${this.nextId++}`
    this.messages.push({ ...message, id, routing, read: false })
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

  async get(id: string): Promise<StoredMessage | null> {
    const stored = this.messages.find((message) => message.id === id)
    return stored ? { ...stored, read: this.read.has(stored.id) } : null
  }

  async unreadForJob(jobId: string): Promise<StoredMessage[]> {
    return (await this.forJob(jobId)).filter((stored) => !stored.read)
  }

  async markRead(ids: string[]): Promise<void> {
    for (const id of ids) this.read.add(id)
  }

  /** Every message routed to the job, for tests to look at. */
  async forJob(jobId: string): Promise<StoredMessage[]> {
    return this.messages
      .filter((stored) => stored.routing.kind === 'job' && stored.routing.jobId === jobId)
      .map((stored) => ({ ...stored, read: this.read.has(stored.id) }))
  }

  async cursor(accountId: string): Promise<string | null> {
    return this.cursors.get(accountId) ?? null
  }

  async setCursor(accountId: string, cursor: string): Promise<void> {
    this.cursors.set(accountId, cursor)
  }
}
