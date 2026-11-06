import type { TurnState } from './agent-provider.js'

/**
 * What a session's terminal process is in the middle of, if anything: a move to
 * the chat view would cut it off. A session started with a prompt counts as
 * working from its start: its first hook comes only once the agent CLI has
 * booted, and ending it before that loses the prompt.
 */
export function terminalBusyState(facts: {
  running: boolean
  turn: { state: TurnState; since: number } | null
  /** When the process was started with a prompt (ms); null without one. */
  promptAt: number | null
}): 'working' | 'waiting' | null {
  if (!facts.running) return null
  const { turn, promptAt } = facts
  if (turn?.state === 'working' || turn?.state === 'waiting') return turn.state
  if (promptAt !== null && (!turn || turn.since < promptAt)) return 'working'
  return null
}

/** A session nobody is looking at stops this long after its last activity, unless Settings › Preferences › Sessions says otherwise. */
export const IDLE_MS = 60 * 60 * 1000
/** A session with a window open: someone may be reading it. */
export const WINDOW_OPEN_MS = 2 * 60 * 60 * 1000
/** A card waiting mid-turn for an approval or an answer: stopping the process drops the card. */
export const OPEN_CARD_MS = 4 * 60 * 60 * 1000
/** A session this fresh is not stopped to make room: it just finished, someone is likely about to look. */
export const MAKE_ROOM_MIN_QUIET_MS = 2 * 60 * 1000

/** What the lifecycle rules know about a running chat session. */
export interface ChatSessionFacts {
  clients: number
  /** Its process is gone (a crash): nothing is left to wait for. */
  running: boolean
  turnActive: boolean
  backgroundTasks: number
  openRequests: number
  quietMs: number
}

/** Whether it is between turns with nothing of its own running: stopping it costs nothing but a resume. */
const atRest = (facts: ChatSessionFacts) => !facts.turnActive && facts.backgroundTasks === 0 && facts.openRequests === 0

/**
 * Whether a chat session's process should stop. Work in progress keeps it: a
 * running turn or background task is never cut off for being quiet. Otherwise
 * it stops once quiet for `idleMs`, a session with a window open or a card
 * waiting for someone later. The conversation stays on disk, so a stopped
 * session loses nothing but its process; a message or opening it resumes it.
 */
export function chatSessionShouldStop(facts: ChatSessionFacts & { idleMs: number }): boolean {
  if (!facts.running) return facts.clients === 0
  if (facts.turnActive && facts.openRequests === 0) return false
  if (facts.backgroundTasks > 0) return false
  const limit = facts.openRequests > 0 ? Math.max(OPEN_CARD_MS, facts.idleMs)
    : facts.clients > 0 ? Math.max(WINDOW_OPEN_MS, facts.idleMs)
      : facts.idleMs
  return facts.quietMs >= limit
}

/**
 * Over the cap on running sessions: the one to stop to make room. Only one at
 * rest and quiet for a moment; one nobody is looking at first, then the one
 * quiet longest. Null: every session is busy, so a new worker waits.
 */
export function sessionToStopForRoom<T extends ChatSessionFacts & { sessionId: string }>(sessions: T[]): string | null {
  const candidates = sessions.filter((s) => s.running && atRest(s) && s.quietMs >= MAKE_ROOM_MIN_QUIET_MS)
  candidates.sort((a, b) => (a.clients > 0 ? 1 : 0) - (b.clients > 0 ? 1 : 0) || b.quietMs - a.quietMs)
  return candidates[0]?.sessionId ?? null
}
