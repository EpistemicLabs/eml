/**
 * What the SendMessage hook does with a call (send-message-hook.ts). SendMessage
 * only reaches a running session, so the host takes a message for a stopped one.
 * Pure, so the rule can be read and tested without Claude Code or the host.
 */

export interface WakeRequest {
  /** The address, without the listing's ` [ref]`. */
  target: string
  text: string
  /** The caller also asked for an idle notice, which a message through the host can't set up. */
  notifyWhenIdle: boolean
}

const WITH_REF = /^(.*\S)\s+\[[0-9a-zA-Z]+\]$/

/** The message to ask the host about, or null when the call is none of the host's business. */
export function wakeRequest(hook: unknown): WakeRequest | null {
  const payload = hook as { tool_name?: unknown; tool_input?: { to?: unknown; message?: unknown; notify_when_idle?: unknown } } | null
  if (payload?.tool_name !== 'SendMessage') return null
  const { to, message, notify_when_idle: notify } = payload.tool_input ?? {}
  if (typeof to !== 'string' || typeof message !== 'string' || !message.trim()) return null
  const target = to.trim().replace(WITH_REF, '$1')
  return target ? { target, text: message, notifyWhenIdle: notify === true } : null
}

/**
 * What the sender reads after the host took its message: the call is cancelled,
 * so the tool shows as refused, and this has to say plainly that nothing failed.
 * Null for every other outcome: then SendMessage goes ahead as if no hook ran.
 */
export function wakeResult(outcome: unknown, request: WakeRequest, from: string | undefined): string | null {
  if (outcome !== 'resumed') return null
  return [
    `Delivered, not an error, do not send it again: ${request.target} had stopped, so the cockpit woke it and it has your message.`,
    from ? `It can answer you at ${from}.` : null,
    request.notifyWhenIdle ? 'No idle notice was set up. It runs now, so SendMessage with notify_when_idle and no message subscribes.' : null,
  ].filter(Boolean).join(' ')
}
