import { describe, it, expect } from 'vitest'
import type { ChannelAccount } from '../../src/ports/channel'

/** A channel account under test, and a way to make a mail arrive on it. */
export interface ChannelHarness {
  account: ChannelAccount
  arrive(id: string): void
}

/** What every channel account must do. */
export function channelAccountContract(name: string, make: () => Promise<ChannelHarness>): void {
  describe(`ChannelAccount contract: ${name}`, () => {
    it('starts from now, then hands out each new message once', async () => {
      const { account, arrive } = await make()
      const first = await account.sync(null)
      if (first.kind !== 'synced') throw new Error('expected synced')
      expect(first.messages).toEqual([])
      arrive('n-1')
      arrive('n-2')
      const second = await account.sync(first.cursor)
      if (second.kind !== 'synced') throw new Error('expected synced')
      expect(second.messages.map((m) => m.channelMessageId)).toEqual(['n-1', 'n-2'])
      expect(second.messages.every((m) => m.accountId === account.accountId && m.channel === account.channel)).toBe(true)
      const third = await account.sync(second.cursor)
      expect(third).toMatchObject({ kind: 'synced', messages: [] })
    })

    it('sends a message once, however often it is asked with the same key', async () => {
      const { account } = await make()
      const message = { to: 'team@shop.example', threadKey: null, subject: 'Hello', text: 'Hi', idempotencyKey: 'k-1' }
      const first = await account.send(message)
      const second = await account.send(message)
      expect(first.kind).toBe('sent')
      expect(second).toEqual(first)
    })
  })
}
