import type { DeliveryOutcome } from '../domain/session-delivery.js'

export interface MessageRequest {
  /** A session id or address. */
  target: string
  text: string
  /** Who it is from, as the session reads it. */
  from: string | null
  /** An outside service may only reach sessions started as wakeable. */
  caller: 'session' | 'outside'
}

export interface DeliverMessageDeps {
  find(target: string): { sessionId: string; wakeable: boolean } | null
  /** Its terminal process is alive: typing into a terminal mid-work isn't safe. */
  terminalRuns(sessionId: string): boolean
  runsInChat(sessionId: string): boolean
  chatRuns(sessionId: string): boolean
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
  if (deps.terminalRuns(session.sessionId)) return 'busy'
  if (!deps.chatRuns(session.sessionId) && !deps.runsInChat(session.sessionId)) return 'refused'
  return deps.deliver(session.sessionId, request.from ? `[Message from ${request.from}]\n\n${request.text}` : request.text)
}
