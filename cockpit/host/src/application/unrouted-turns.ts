import type { SessionLedger } from '../session-ledger.js'
import type { TaskRouter } from './task-router.js'

/**
 * What a session said in a turn (its end_turn call, or a status) is kept in the ledger until the router has written
 * it into its task (session-ledger.ts unrouted). A turn that ended while the host went down for an update, or whose
 * route failed (the brain did not answer), is left over: this routes it once the host runs again, and on every tick
 * after, until it lands.
 *
 * Left alone: a session in a turn (it may still say more; its turn's end routes it), one whose turn end is being
 * routed, and one put away. What is older than MAX_AGE_MS is dropped instead: by then it no longer says how the task
 * stands, and the user has moved on.
 */

export const MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface UnroutedTurnsDeps {
  ledger: Pick<SessionLedger, 'list' | 'clearUnrouted'>
  router: Pick<TaskRouter, 'turnEnded' | 'routing'>
  /** The session is in a turn now. */
  working(sessionId: string): boolean
  log(line: string): void
  now?: () => number
}

/** Routes every left-over turn that is due; resolves with how many it tried once each was. Never throws. */
export async function routeUnrouted(deps: UnroutedTurnsDeps): Promise<number> {
  const now = deps.now?.() ?? Date.now()
  let tried = 0
  for (const entry of deps.ledger.list()) {
    const said = entry.unrouted
    if (!said || entry.archivedAt || entry.turnInFlight || deps.working(entry.sessionId) || deps.router.routing(entry.sessionId)) continue
    const at = Date.parse(said.at)
    if (!Number.isFinite(at) || now - at > MAX_AGE_MS) {
      deps.ledger.clearUnrouted(entry.sessionId, said.at)
      deps.log(`[router] ${entry.sessionId.slice(0, 8)} dropped what it said at ${said.at}: older than a day, never routed`)
      continue
    }
    deps.log(`[router] ${entry.sessionId.slice(0, 8)} routing what it said at ${said.at}, left over from an earlier turn end`)
    await deps.router.turnEnded(entry.sessionId, '', said.call, { ctx: said.ctx })
    tried++
  }
  return tried
}
