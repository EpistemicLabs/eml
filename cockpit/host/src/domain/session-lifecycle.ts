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
