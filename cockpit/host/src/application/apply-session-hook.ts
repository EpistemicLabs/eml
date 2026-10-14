import type { ProviderRegistry } from '../infrastructure/providers/registry.js'
import type { SessionLedger } from '../session-ledger.js'
import type { TurnTracker } from '../turn-state.js'

export interface SessionHookDeps {
  providers: ProviderRegistry
  ledger: SessionLedger
  turns: TurnTracker
}

/**
 * A session hook arrived at POST /api/hook: turn it into turn state.
 *
 * The hook names the cockpit session it runs in (HOOK_SESSION_HEADER, from the
 * session's env); its payload carries the provider's own id of the
 * conversation. The first hook of a session binds the two in the ledger —
 * resume and transcripts need the provider's id.
 *
 * A hook whose provider id is not the session's is dropped: an agent CLI
 * started from inside a session (a shell command, a script) inherits the
 * session's env and config, so its hooks name the same cockpit session while
 * reporting a conversation of their own. They must neither move the pane's
 * turn state nor take over its resume target.
 *
 * `namedSessionId` is null for a hook without the header; its payload id is
 * then taken as the cockpit's.
 */
export function applySessionHook(deps: SessionHookDeps, namedSessionId: string | null, payload: Record<string, unknown>): void {
  const provider = namedSessionId ? deps.providers.forSession(namedSessionId) : deps.providers.default()
  const signal = provider.turnSignal(payload)
  if (!signal) return
  if (signal.kind === 'unclassified') {
    deps.turns.note(signal.label)
    return
  }
  const sessionId = namedSessionId ?? signal.providerSessionId
  const known = deps.ledger.get(sessionId)?.providerSessionId ?? (provider.adoptsSessionId ? sessionId : null)
  if (known && known !== signal.providerSessionId) return
  deps.ledger.bindProviderSession(sessionId, signal.providerSessionId)
  deps.turns.apply({ sessionId, state: signal.state, settleMs: signal.settleMs })
}
