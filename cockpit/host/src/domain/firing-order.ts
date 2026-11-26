/**
 * The four-line order (decision task-schedules-live-in-the-brain): what the cockpit does when a task comes due.
 * The first line that applies decides.
 *
 *   a. A session of the task is working now → a repeating time that is due (and a run started by hand) is skipped
 *      and recorded. The wake-up is not: it carries a reason, like a message, so it stays due on the task and fires
 *      in the first pass where a later line can give it to a session (application/job-runner.ts deriveTask). A
 *      channel message from the bridge is never skipped either: it goes to that session with its next turn, or the
 *      bridge is told to try again.
 *   b. A session of the task waits on an answer (a wait of kind question or go, not a review) → that session
 *      continues and gets the firing as a message.
 *   c. Nothing is open and the wake-up is due → the session that set it continues; when it is gone or cannot be
 *      woken, a new session starts.
 *   d. Nothing is open and a repeating time or a message is due → a new session starts.
 *
 * A firing that names the wake-up and repeating times is one run, and goes where the wake-up goes: the session that
 * set it knows what it wanted to check, and the firing's text names the repeating times too.
 *
 * Pure: the caller says what it knows of the task's sessions, carries the answer out, and asks again without a
 * session that turned out not to take a message.
 */

/** The wait kinds that hold a session open for an answer: its question, or its plan waiting for the go. */
export const ANSWER_WAITS: readonly string[] = ['question', 'go']

/** One of this cockpit's sessions on the task. A session that is put away or unknown here is left out, or not wakeable. */
export interface FiringSession {
  sessionId: string
  /** It is in a turn now. */
  working: boolean
  /** The kind of the wait the task holds for it (the entry of the task's waits with its session id); null: none. */
  wait: string | null
  /** A message reaches it: it is known here, not put away, and has not refused one. */
  wakeable: boolean
}

export interface Fired {
  /** A time came due: a repeating time, the wake-up, or a run the owner started by hand. */
  times: boolean
  /** The wake-up is among what fired; bySession: the session that set it, if it said so. */
  wake: { bySession: string | null } | null
  /** A channel message from the bridge is among what fired. */
  message: boolean
}

export interface FiringFacts {
  fired: Fired
  /** The task's sessions here, in the order the caller prefers them (newest first). */
  sessions: readonly FiringSession[]
  /** A session this cockpit does not have works on the task right now (another member's run, domain/runs.ts). */
  workingElsewhere: boolean
}

export type FiringDecision =
  /** Line a, a time: nothing runs now. The caller records a repeating time as skipped and keeps the wake-up due. */
  | { kind: 'skip' }
  /** Line a, a message: the working session gets it with its next turn. */
  | { kind: 'deliver'; sessionId: string }
  /** Lines b and c: this session continues with the firing as a message. `line` says which line decided. */
  | { kind: 'resume'; sessionId: string; line: 'waiting' | 'wake' }
  /** Lines c and d: a new session of the task starts. */
  | { kind: 'start' }
  /** Line a, a message no working session here can take: the bridge tries again. Never for a time. */
  | { kind: 'retry' }

export function decideFiring(facts: FiringFacts): FiringDecision {
  const { fired, sessions } = facts
  const working = sessions.filter((s) => s.working)
  if (working.length > 0 || facts.workingElsewhere) {
    if (!fired.message) return { kind: 'skip' }
    const taker = working.find((s) => s.wakeable)
    return taker ? { kind: 'deliver', sessionId: taker.sessionId } : { kind: 'retry' }
  }
  // A question comes before a plan waiting for its go, as the task's most urgent wait does (domain/task-waits.ts).
  for (const kind of ANSWER_WAITS) {
    const waiting = sessions.find((s) => s.wakeable && s.wait === kind)
    if (waiting) return { kind: 'resume', sessionId: waiting.sessionId, line: 'waiting' }
  }
  const setter = fired.wake?.bySession ? sessions.find((s) => s.sessionId === fired.wake!.bySession && s.wakeable) : undefined
  if (setter) return { kind: 'resume', sessionId: setter.sessionId, line: 'wake' }
  return { kind: 'start' }
}
