import { routeMessage } from '../domain/routing'
import type { ChannelAccount } from '../ports/channel'
import type { Clock } from '../ports/clock'
import type { JobRoute } from '../domain/routing'
import type { DirectoryUnavailable, JobDirectory } from '../ports/job-directory'
import type { MessageStore } from '../ports/message-store'
import type { WakeQueue } from '../ports/wake-queue'

export interface SyncChannelDeps {
  store: MessageStore
  jobs: JobDirectory
  wakes: WakeQueue
  clock: Clock
}

export interface SyncSummary {
  kind: 'synced'
  stored: number
  duplicates: number
  toJobs: number
  toInbox: number
  ignored: number
}

/**
 * Takes what arrived on one account since its cursor. Without the cockpit's answer on the space's
 * jobs it stores nothing and keeps the cursor, since routing blind would send everything to the
 * inbox. Otherwise it stores each message once, routes it among the jobs of the account's space,
 * and queues a wake for each job that got one. The
 * cursor moves only after everything is stored, so a crash repeats a sync instead of losing
 * messages; the duplicates it brings are recognised and their wakes made good.
 */
export async function syncChannel(
  deps: SyncChannelDeps,
  input: { account: ChannelAccount },
): Promise<SyncSummary | DirectoryUnavailable> {
  const { account } = input
  const summary: SyncSummary = { kind: 'synced', stored: 0, duplicates: 0, toJobs: 0, toInbox: 0, ignored: 0 }
  const result = await account.sync(await deps.store.cursor(account.accountId))
  let routes: JobRoute[] = []
  if (result.messages.length > 0) {
    const answer = await deps.jobs.routesInSpace(account.space, account.channel)
    if (answer.kind === 'unavailable') return answer
    routes = answer.routes
  }

  for (const message of result.messages) {
    const threadOwner = await deps.store.threadOwner(account.accountId, message.threadKey)
    const routing = routeMessage(message, { routes, threadOwner })
    const saved = await deps.store.save(message, routing)
    if (saved.kind === 'duplicate') {
      summary.duplicates += 1
      await wakeForUnread(deps, account.space, saved.id)
      continue
    }
    summary.stored += 1
    if (routing.kind === 'job') {
      summary.toJobs += 1
      await deps.wakes.add({ jobId: routing.jobId, space: account.space }, { kind: 'message', messageId: saved.id }, deps.clock.now())
    } else if (routing.kind === 'inbox') {
      summary.toInbox += 1
    } else {
      summary.ignored += 1
    }
  }

  await deps.store.setCursor(account.accountId, result.cursor)
  return summary
}

/**
 * A duplicate means an earlier sync stopped before it moved the cursor, perhaps before it queued
 * the wake. A message its job has not read yet is queued again; the queue holds it once.
 */
async function wakeForUnread(deps: SyncChannelDeps, space: string, messageId: string): Promise<void> {
  const stored = await deps.store.get(messageId)
  if (stored?.routing.kind !== 'job' || stored.read) return
  await deps.wakes.add({ jobId: stored.routing.jobId, space }, { kind: 'message', messageId }, deps.clock.now())
}
