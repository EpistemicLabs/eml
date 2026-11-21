import { describe, it, expect } from 'vitest'
import { channelAccountContract } from '@engramprotocol/channel-bridge-sdk/testing'
import { ScriptedChannel } from '../src/adapters/fake-channel/scripted-channel'

channelAccountContract({ describe, it, expect }, 'scripted', async () => {
  const channel = new ScriptedChannel('acc-1', 'support')
  return {
    account: channel,
    arrive: (id) => channel.receive({
      channelMessageId: id, threadKey: `t-${id}`, from: 'team@shop.example', senderVerified: true, automated: false,
      receivedAt: '2026-11-08T10:00:00.000Z', subject: 'Hi', text: 'Hello',
    }),
  }
})
