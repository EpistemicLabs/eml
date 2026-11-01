/**
 * What came of a message for a session.
 *   delivered  the running session has it
 *   resumed    the session had stopped; it runs again and has it
 *   busy       it can't take it now (in a terminal, or being switched); try again
 *   unknown    no such session
 *   refused    this caller may not message it, or it can't run in chat
 */
export type DeliveryOutcome = 'delivered' | 'resumed' | 'busy' | 'unknown' | 'refused'
