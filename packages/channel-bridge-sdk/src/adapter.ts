import type { z } from 'zod'
import type { ChannelAccount } from './account'

/** What the bridge knows about an account before its adapter creates it. */
export interface AdapterContext {
  /** Unique across all accounts of the bridge. */
  readonly accountId: string
  /** The agent spaces where its plugin is on: its messages are routed among their jobs. */
  readonly spaces: readonly string[]
}

/**
 * A plugin's channel part: the account type it serves, the shape of its settings in the bridge's
 * accounts file, and how it makes a live account from them. The bridge picks the adapter by `type`
 * and hands it only the fields of that one account entry.
 */
export interface ChannelAdapter<Config = unknown> {
  /** The `type` of an entry in the accounts file, e.g. "gmail". */
  readonly type: string
  /** Validates one accounts file entry; `type`, `accountId` and `spaces` are in it too. */
  readonly configSchema: z.ZodType<Config>
  create(config: Config, context: AdapterContext): ChannelAccount
}

/** Keeps the config type of an adapter checked where it is declared. */
export function defineChannelAdapter<Config>(adapter: ChannelAdapter<Config>): ChannelAdapter<Config> {
  return adapter
}
