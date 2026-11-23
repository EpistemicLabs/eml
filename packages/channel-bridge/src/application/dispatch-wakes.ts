import { afterFailedDelivery, describeWake, wakeDueAt } from '../domain/wake'
import type { Clock } from '../ports/clock'
import type { Cockpit } from '../ports/cockpit'
import type { WakeQueue } from '../ports/wake-queue'

export interface DispatchWakesDeps {
  wakes: WakeQueue
  cockpit: Cockpit
  clock: Clock
}

export interface DispatchSummary {
  delivered: number
  retrying: number
  dead: number
}

/**
 * Hands every due wake to the cockpit. The cockpit decides whether a session may run now; a
 * wake it cannot take waits and is tried again, one it refuses is kept as dead. A wake is
 * named by its job and its last entry, so a retry is recognised as the same wake.
 */
export async function dispatchWakes(deps: DispatchWakesDeps, input: { collectMs: number }): Promise<DispatchSummary> {
  const summary: DispatchSummary = { delivered: 0, retrying: 0, dead: 0 }
  const now = deps.clock.now()

  for (const { wake, upTo } of await deps.wakes.pending()) {
    if (Date.parse(wakeDueAt(wake, input.collectMs)) > Date.parse(now)) continue
    const outcome = await deps.cockpit.wakeJob({
      jobId: wake.jobId,
      space: wake.space,
      text: describeWake(wake),
      idempotencyKey: `${wake.jobId}:${upTo}`,
    })
    if (outcome === 'delivered') {
      await deps.wakes.delivered(wake.jobId, upTo)
      summary.delivered += 1
      continue
    }
    const next = outcome === 'retry' ? afterFailedDelivery(wake, now) : { kind: 'dead' as const }
    if (next.kind === 'retry') {
      await deps.wakes.retryLater(wake.jobId, next.wake.attempts, next.wake.retryAt ?? now)
      summary.retrying += 1
    } else {
      await deps.wakes.dead(wake.jobId, upTo)
      summary.dead += 1
    }
  }
  return summary
}
