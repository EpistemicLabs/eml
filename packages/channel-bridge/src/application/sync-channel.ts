import { routeMessage } from '../domain/routing'
import type { ChannelAccount, ChannelUnavailable } from '../ports/channel'
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
  /** The channel started again from now; messages between may be missing. */
  gap: boolean
  stored: number
  duplicates: number
  toJobs: number
  toInbox: number
  ignored: number
}

/**
 * Takes what arrived on one account since its cursor. Without the cockpit's answer on the space's
 * jobs it stores nothing and keeps the cursor, since routing blind would send everything to the
 * inbox. Otherwise it stores each message once, routes it among the jobs of all the account's spaces,
 * and queues a wake for each job that got one. The
 * cursor moves only after everything is stored, so a crash repeats a sync instead of losing
 * messages; the duplicates it brings are recognised and their wakes made good.
 */
export async function syncChannel(
  deps: SyncChannelDeps,
  input: { account: ChannelAccount },
): Promise<SyncSummary | DirectoryUnavailable | ChannelUnavailable> {
  const { account } = input
  const result = await account.sync(await deps.store.cursor(account.accountId))
  if (result.kind === 'unavailable') return result
  const summary: SyncSummary = { kind: 'synced', gap: result.gap, stored: 0, duplicates: 0, toJobs: 0, toInbox: 0, ignored: 0 }
  // No home space: the jobs of every space the account's plugin is on in, merged (job ids are unique).
  let routes: JobRoute[] = []
  if (result.messages.length > 0) {
    for (const space of account.spaces) {
      const answer = await deps.jobs.routesInSpace(space, account.channel)
      if (answer.kind === 'unavailable') return answer
      routes = [...routes, ...answer.routes]
    }
  }
  // A wake goes to the job's own space: the cockpit takes it only with that space's token.
  const spaceOf = (jobId: string) => routes.find((route) => route.jobId === jobId)?.space ?? null

  for (const message of result.messages) {
    const threadOwner = await deps.store.threadOwner(account.accountId, message.threadKey)
    const routing = routeMessage(message, { routes, threadOwner })
    const saved = await deps.store.save(message, routing)
    if (saved.kind === 'duplicate') {
      summary.duplicates += 1
      await wakeForUnread(deps, spaceOf, saved.id)
      continue
    }
    summary.stored += 1
    if (routing.kind === 'job') {
      summary.toJobs += 1
      const space = spaceOf(routing.jobId)
      if (space) await deps.wakes.add({ jobId: routing.jobId, space }, { kind: 'message', messageId: saved.id }, deps.clock.now())
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
async function wakeForUnread(deps: SyncChannelDeps, spaceOf: (jobId: string) => string | null, messageId: string): Promise<void> {
  const stored = await deps.store.get(messageId)
  if (stored?.routing.kind !== 'job' || stored.read) return
  const space = spaceOf(stored.routing.jobId)
  if (space) await deps.wakes.add({ jobId: stored.routing.jobId, space }, { kind: 'message', messageId }, deps.clock.now())
}
