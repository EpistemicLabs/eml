import { routeMessage } from '../domain/routing'
import type { ChannelAccount } from '../ports/channel'
import type { Clock } from '../ports/clock'
import type { JobDirectory } from '../ports/job-directory'
import type { MessageStore } from '../ports/message-store'
import type { WakeQueue } from '../ports/wake-queue'

export interface SyncChannelDeps {
  store: MessageStore
  jobs: JobDirectory
  wakes: WakeQueue
  clock: Clock
}

export interface SyncSummary {
  stored: number
  duplicates: number
  toJobs: number
  toInbox: number
  ignored: number
}

/**
 * Takes what arrived on one account since its cursor: stores each message once, routes it
 * among the jobs of the account's space, and queues a wake for each job that got one. The
 * cursor moves only after everything is stored, so a crash repeats a sync instead of losing
 * messages; the duplicates it brings are recognised.
 */
export async function syncChannel(deps: SyncChannelDeps, input: { account: ChannelAccount }): Promise<SyncSummary> {
  const { account } = input
  const summary: SyncSummary = { stored: 0, duplicates: 0, toJobs: 0, toInbox: 0, ignored: 0 }
  const result = await account.sync(await deps.store.cursor(account.accountId))
  const routes = result.messages.length > 0 ? await deps.jobs.routesInSpace(account.space) : []

  for (const message of result.messages) {
    const threadOwner = await deps.store.threadOwner(account.accountId, message.threadKey)
    const routing = routeMessage(message, { routes, threadOwner })
    const saved = await deps.store.save(message, routing)
    if (saved.kind === 'duplicate') {
      summary.duplicates += 1
      continue
    }
    summary.stored += 1
    if (routing.kind === 'job') {
      summary.toJobs += 1
      await deps.wakes.add(routing.jobId, { kind: 'message', messageId: saved.id }, deps.clock.now())
    } else if (routing.kind === 'inbox') {
      summary.toInbox += 1
    } else {
      summary.ignored += 1
    }
  }

  await deps.store.setCursor(account.accountId, result.cursor)
  return summary
}
