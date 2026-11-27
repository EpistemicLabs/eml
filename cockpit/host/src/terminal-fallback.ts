import { readAgentSettings, writeAgentSettings } from './provider-settings.js'

/**
 * Settings › Advanced › Terminal fallback: the cockpit-wide switch that lets the user open an agent session in a
 * terminal (the PTY bridge) instead of its chat. Every session runs in its chat runtime; the terminal is only the
 * hidden fallback, off unless switched on. Kept in agents.json (provider-settings.ts) and read on every use, so a
 * change holds from the next pane that opens.
 *
 * While it is off, the PTY bridge refuses an agent session's `init` with TERMINAL_FALLBACK_OFF. The Shell plugin's
 * terminal (the user's own login shell) is not an agent session and is not affected.
 */

const KEY = 'terminalFallback'

/** The error code a refused terminal attach carries (pty-bridge.ts `{ type: 'error', code, message }`). */
export const TERMINAL_FALLBACK_OFF = 'TERMINAL_FALLBACK_OFF'
export const TERMINAL_FALLBACK_OFF_MESSAGE = 'Sessions run in the chat. To open one in a terminal, turn on Settings › Advanced › Terminal fallback.'

export interface TerminalFallback {
  enabled: boolean
}

export function readTerminalFallback(): TerminalFallback {
  return { enabled: readAgentSettings()[KEY] === true }
}

/** PATCH body { enabled: boolean }; returns the setting as it is now, or why the body was refused. */
export function writeTerminalFallback(body: unknown): TerminalFallback | string {
  const enabled = body && typeof body === 'object' ? (body as Record<string, unknown>).enabled : undefined
  if (typeof enabled !== 'boolean') return 'enabled must be true or false'
  writeAgentSettings({ [KEY]: enabled })
  return { enabled }
}
