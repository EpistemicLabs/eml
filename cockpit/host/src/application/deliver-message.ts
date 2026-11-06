import type { DeliveryOutcome } from '../domain/session-delivery.js'

export interface MessageRequest {
  /** A session id or address. */
  target: string
  text: string
  /** Who it is from, as the session reads it. */
  from: string | null
  /** An outside service may only reach sessions started as wakeable. */
  caller: 'session' | 'outside'
  /**
   * SendMessage's way (send-message-hook.ts), with the sending session's id: only a stopped
   * session it could reach while running gets it. A running one answers 'running'.
   */
  onlyIfStoppedFor?: string
}

export interface DeliverMessageDeps {
  find(target: string): { sessionId: string; wakeable: boolean } | null
  /** Its terminal process is alive: typing into a terminal mid-work isn't safe. */
  terminalRuns(sessionId: string): boolean
  runsInChat(sessionId: string): boolean
  chatRuns(sessionId: string): boolean
  /** Whether SendMessage gets from one to the other while both run: spaces with their own agent are apart. */
  sameReach(fromSessionId: string, sessionId: string): boolean
  deliver(sessionId: string, text: string): Promise<DeliveryOutcome>
}

/**
 * The one way to reach a session from anywhere: another session, an outside
 * service, later a dispatcher. A stopped session resumes first. The outcome is
 * only 'delivered' or 'resumed' once the session has the message, so a sender
 * that sees anything else, or nothing, tries again.
 */
export async function deliverMessage(deps: DeliverMessageDeps, request: MessageRequest): Promise<DeliveryOutcome> {
  const session = deps.find(request.target)
  if (!session) return 'unknown'
  if (request.caller === 'outside' && !session.wakeable) return 'refused'
  if (request.onlyIfStoppedFor !== undefined) {
    if (!deps.sameReach(request.onlyIfStoppedFor, session.sessionId)) return 'unknown'
    if (deps.terminalRuns(session.sessionId) || deps.chatRuns(session.sessionId)) return 'running'
  }
  if (deps.terminalRuns(session.sessionId)) return 'busy'
  if (!deps.chatRuns(session.sessionId) && !deps.runsInChat(session.sessionId)) return 'refused'
  return deps.deliver(session.sessionId, withSender(request))
}

/** A woken session reads this as a prompt, so it has to say that no user wrote it and how to answer. */
function withSender({ from, text, caller }: MessageRequest): string {
  if (!from) return text
  return caller === 'session'
    ? `[Message from ${from}, another session, not your user. To answer, use SendMessage to ${from}.]\n\n${text}`
    : `[Message from ${from}]\n\n${text}`
}
