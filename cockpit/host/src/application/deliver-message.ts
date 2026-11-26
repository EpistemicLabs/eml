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
  /**
   * The sending session cannot be messaged back (it runs in a terminal): the receiver reads who wrote
   * and that its answer goes through the task or the user, instead of how to reply.
   */
  noReply?: boolean
  /** The cockpit's one reminder of a stop (domain/turn-end.ts): the turn it starts gets no reminder of its own. */
  reminder?: boolean
}

export interface DeliverMessageDeps {
  find(target: string): { sessionId: string; wakeable: boolean } | null
  /**
   * Its provider lets this session be handed a message where it ran last (domain/agent-provider.ts sessionMessaging):
   * a Codex session that ran in a terminal never is, running or stopped.
   */
  canReceive(sessionId: string): boolean
  /** Its terminal process is alive: typing into a terminal mid-work isn't safe. */
  terminalRuns(sessionId: string): boolean
  /** Stopped, it would resume in the chat: its provider's sessions run there now. */
  runsInChat(sessionId: string): boolean
  chatRuns(sessionId: string): boolean
  /** Whether SendMessage gets from one to the other while both run: spaces with their own agent are apart. */
  sameReach(fromSessionId: string, sessionId: string): boolean
  deliver(sessionId: string, text: string, opts?: { reminder?: boolean }): Promise<DeliveryOutcome>
  /** The tool the session answers another session with, as it knows it; absent: SendMessage (Claude Code's own). */
  replyTool?(sessionId: string): string
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
  if (!deps.canReceive(session.sessionId)) return 'refused'
  if (deps.terminalRuns(session.sessionId)) return 'busy'
  if (!deps.chatRuns(session.sessionId) && !deps.runsInChat(session.sessionId)) return 'refused'
  const replyTool = deps.replyTool?.(session.sessionId) ?? 'SendMessage'
  return deps.deliver(session.sessionId, withSender(request, replyTool), request.reminder ? { reminder: true } : undefined)
}

/** A woken session reads this as a prompt, so it has to say that no user wrote it and how to answer. */
function withSender({ from, text, caller, noReply }: MessageRequest, replyTool: string): string {
  if (!from) return text
  if (caller !== 'session') return `[Message from ${from}]\n\n${text}`
  return noReply
    ? `[Message from ${from}, another session, not your user. A reply does not reach ${from}: put your answer into the task, or tell your user.]\n\n${text}`
    : `[Message from ${from}, another session, not your user. To answer, use ${replyTool} to ${from}.]\n\n${text}`
}
