import type { ProviderRegistry } from '../infrastructure/providers/registry.js'
import type { SessionLedger } from '../session-ledger.js'
import type { TurnTracker } from '../turn-state.js'

export interface SessionHookDeps {
  providers: ProviderRegistry
  ledger: SessionLedger
  turns: TurnTracker
  /** A turn finished: the task router reads its handoff (application/task-router.ts). */
  turnDone?: (sessionId: string, payload: Record<string, unknown>) => void
  /** The user typed into the session: whatever it waited for is answered (task router). */
  answered?: (sessionId: string) => void
  /** The user typed a prompt into the session's terminal: a closed task it works on reopens first. */
  userWrote?: (sessionId: string) => void
  /**
   * The user sent a prompt into the session's terminal (TurnSignal.prompt): a new turn starts, and what the
   * session said in a turn that never ended no longer stands (application/terminal-turns.ts).
   */
  turnStarted?: (sessionId: string) => void
  /**
   * A chat session's turn ended while subagents it started still run, and it asks nobody anything:
   * they wake it again, so its done is not applied and it stays working. Whoever answers true ends
   * the turn state itself once they are back (chat-bridge.ts holdTurnOpen).
   */
  waitsOnHelpers?: (sessionId: string) => boolean
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
  // Claude Code and Codex send the folder the agent works in with every hook: the Worktrees plugin's session ↔ worktree.
  if (typeof payload.cwd === 'string' && payload.cwd) deps.ledger.setWorkdir(sessionId, payload.cwd)
  // A terminal process dies with the host without a word, so its hooks are all there is to go by.
  if (signal.state === 'working' || signal.state === 'done') deps.ledger.setTurnInFlight(sessionId, signal.state === 'working')
  // A chat session's result comes from its own turn end (chat-bridge.ts); only a terminal has its hooks to go by.
  const terminal = deps.ledger.get(sessionId)?.runtime === 'terminal'
  if (signal.state === 'working') deps.ledger.setResult(sessionId, false)
  else if (signal.state === 'done' && terminal) deps.ledger.setResult(sessionId, true)
  // A prompt typed into a terminal is a new turn, as a chat message is (chat-bridge.ts sendMessage):
  // whoever it waited for has answered, and an archived session is back in the lists.
  if (signal.state === 'working' && terminal) {
    const asked = deps.ledger.get(sessionId)
    if (asked?.attention || asked?.taskId) deps.answered?.(sessionId)
    deps.ledger.setAttention(sessionId, null)
    deps.ledger.unarchive(sessionId)
    deps.userWrote?.(sessionId)
    if (signal.prompt) deps.turnStarted?.(sessionId)
  }
  // A turn that ends with a question for the user ends as done: its flag keeps it in Your turn,
  // the desk dot clears once seen. Only a live prompt is waiting (decision desk-dot-until-seen).
  const held = signal.state === 'done' && deps.waitsOnHelpers?.(sessionId) === true
  if (!held) deps.turns.apply({ sessionId, state: signal.state, settleMs: signal.settleMs })
  if (signal.state === 'done' && terminal) deps.turnDone?.(sessionId, payload)
}
