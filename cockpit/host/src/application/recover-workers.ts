import type { DeliveryOutcome } from '../domain/session-delivery.js'
import type { Attention } from '../domain/session-attention.js'

export const RECOVERY_MESSAGE = 'The host restarted and cut off your turn. First check what was already done, since something may have gone through without you seeing it. Then continue.'

export interface RecoverWorkersDeps {
  /** Workers whose turn was still running when the host went down. */
  interrupted(): Array<{ sessionId: string; retried: boolean }>
  markRetried(sessionId: string): void
  giveUp(sessionId: string, attention: Attention, reason: string): void
  deliver(sessionId: string, text: string): Promise<DeliveryOutcome>
  /** Resolves once the machine has room for one more running session; a restart must not start them all at once. */
  waitForRoom?: () => Promise<void>
  log: (line: string) => void
}

/** Workers a host shutdown cut off mid-turn. An archived one is put away, whatever its flag says. */
export function interruptedWorkers(sessions: Array<{ sessionId: string; turnInFlight: { retried: boolean } | null; archivedAt: string | null }>): Array<{ sessionId: string; retried: boolean }> {
  return sessions.flatMap(({ sessionId, turnInFlight, archivedAt }) => (turnInFlight && !archivedAt ? [{ sessionId, retried: turnInFlight.retried }] : []))
}

/**
 * After a host start: a worker cut off mid-turn gets one message to carry on. Cut off
 * again before that turn ends, or if it can't take a message, it waits for someone
 * instead, so a restart can't loop. They go one by one, each once there is room
 * for it. Returns how many were sent on their way.
 */
export async function recoverWorkers(deps: RecoverWorkersDeps): Promise<number> {
  let recovered = 0
  for (const { sessionId, retried } of deps.interrupted()) {
    if (retried) {
      deps.giveUp(sessionId, 'failed', 'Cut off by host restarts twice in one turn.')
      continue
    }
    await deps.waitForRoom?.()
    deps.markRetried(sessionId)
    const outcome = await deps.deliver(sessionId, RECOVERY_MESSAGE).catch(() => 'refused' as const)
    if (outcome === 'delivered' || outcome === 'resumed') {
      recovered += 1
      deps.log(`[worker] ${sessionId} continues after the restart`)
    } else deps.giveUp(sessionId, 'failed', 'Cut off by a host restart, and it could not be resumed.')
  }
  return recovered
}
