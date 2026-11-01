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

/** A chat session of the user's with no window open stops this long after its last activity. */
export const CLOSED_WINDOW_MS = 30 * 60 * 1000
/** A worker with nobody attached, or a session holding a question for someone, stops after this long. */
export const UNATTENDED_MS = 24 * 60 * 60 * 1000

/**
 * Whether a chat session's process should stop. A window keeps it running, as does
 * work in progress: a running process is never cut off for being quiet. The
 * conversation stays on disk, so a stopped session loses nothing but its process.
 */
export function chatSessionShouldStop(facts: {
  clients: number
  /** Its process is gone (a crash): nothing is left to wait for. */
  running: boolean
  turnActive: boolean
  backgroundTasks: number
  openRequests: number
  worker: boolean
  quietMs: number
}): boolean {
  if (facts.clients > 0) return false
  if (!facts.running) return true
  if (facts.turnActive && facts.openRequests === 0) return false
  if (facts.backgroundTasks > 0) return false
  const limit = facts.worker || facts.openRequests > 0 ? UNATTENDED_MS : CLOSED_WINDOW_MS
  return facts.quietMs >= limit
}
