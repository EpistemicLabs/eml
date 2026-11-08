import { syncChannel } from '../application/sync-channel'
import type { SyncChannelDeps } from '../application/sync-channel'
import { dispatchWakes } from '../application/dispatch-wakes'
import type { DispatchWakesDeps } from '../application/dispatch-wakes'
import type { ChannelAccount } from '../ports/channel'
import type { Log } from './bridge-api'

export type BridgeLoopDeps = SyncChannelDeps & DispatchWakesDeps

export interface BridgeLoopOptions {
  accounts: ChannelAccount[]
  collectMs: number
  log: Log
}

/** One round: sync every account, then hand due wakes to the cockpit. One broken account stops no other. */
export async function runBridgeTick(deps: BridgeLoopDeps, options: BridgeLoopOptions): Promise<void> {
  for (const account of options.accounts) {
    try {
      const summary = await syncChannel(deps, { account })
      if (summary.kind === 'unavailable') options.log('sync.unavailable', { accountId: account.accountId, reason: summary.reason })
      else if (summary.stored > 0) options.log('sync.stored', { accountId: account.accountId, ...summary })
    } catch {
      options.log('sync.failed', { accountId: account.accountId })
    }
  }
  try {
    const summary = await dispatchWakes(deps, { collectMs: options.collectMs })
    if (summary.delivered + summary.retrying + summary.dead > 0) options.log('wakes.dispatched', { ...summary })
  } catch {
    options.log('wakes.failed', {})
  }
}

/** Runs a round every interval; a round that is still running is not started twice. */
export function startBridgeLoop(deps: BridgeLoopDeps, options: BridgeLoopOptions & { everyMs: number }): { stop(): void } {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    runBridgeTick(deps, options).finally(() => {
      running = false
    })
  }, options.everyMs)
  return { stop: () => clearInterval(timer) }
}
