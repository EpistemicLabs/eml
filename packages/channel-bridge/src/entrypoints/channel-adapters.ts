import type { ChannelAdapter } from '@engramprotocol/channel-bridge-sdk'
import { gmailChannel } from '@engramprotocol/plugin-gmail-channel'

/** The channel parts of the official plugins, one per account type the accounts file may name. */
export const channelAdapters: readonly ChannelAdapter[] = [gmailChannel]

/** The adapter for an accounts file `type`, or null for a type no plugin serves. */
export function adapterFor(type: string, adapters: readonly ChannelAdapter[] = channelAdapters): ChannelAdapter | null {
  return adapters.find((adapter) => adapter.type === type) ?? null
}
