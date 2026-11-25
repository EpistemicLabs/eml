/** Why a session waits for someone. Saved, unlike its turn state: it outlives the process. */
export type Attention = 'question' | 'review' | 'failed'

/** What a worker says when it ends a turn. */
export type WorkerStatus = 'done' | Attention

export const WORKER_STATUSES: readonly [WorkerStatus, ...WorkerStatus[]] = ['done', 'question', 'review', 'failed']

/** Only these hold a turn open for someone: review and done are finished work, waiting to be looked at. */
export function needsAnswer(kind: WorkerStatus): boolean {
  return kind === 'question' || kind === 'failed'
}

/**
 * Whether a session works on its own (an agent session) or is the user's
 * conversation (a desk session); decision session-kind-follows-task-delegate.
 * Its task decides, as it stands now: handed to an agent (it names a
 * delegate), the session works on its own, whoever started it. On a task that
 * is not handed over, only a worker a session or a job started still does: it
 * works for them. One the runner started lost its delegation: the owner took
 * the task back, and it is their conversation now. `delegated` null: no task,
 * or it cannot be read; the way the session was started decides.
 */
export function worksAlone(facts: { delegated: boolean | null; worker: boolean; spawned: boolean }): boolean {
  if (facts.delegated) return true
  if (!facts.worker) return false
  return facts.delegated === null || facts.spawned
}

/** A session or a job started it (the runner starts its workers without either). */
export function wasSpawned(entry: { parentSessionId?: string | null; jobId?: string | null }): boolean {
  return Boolean(entry.parentSessionId || entry.jobId)
}

interface TurnFacts {
  /** It works on its own (worksAlone). */
  alone: boolean
  /** Someone has the session open and sees for themselves. */
  clients: number
  /** It said done or why it needs someone during this turn. */
  declared: boolean
}

/**
 * A turn ended while subagents or workflow runs it started in the background
 * still run (`agents` counts both), and it asks nobody anything: its run goes
 * on, this is no stop. They wake it with a new turn when they come back, and
 * that turn is judged on its own. A turn that asks the user (question, review,
 * failed) is a stop, helpers or not.
 */
export function stillRunning(facts: { agents: number; status: WorkerStatus | null }): boolean {
  return facts.agents > 0 && (facts.status === null || facts.status === 'done')
}

/**
 * A session that works on its own, about to end its turn without saying how it stands, is sent back.
 * `asked`: the turn already had its one reminder.
 */
export function shouldAskForStatus(facts: TurnFacts & { asked: boolean }): boolean {
  return facts.alone && facts.clients === 0 && !facts.declared && !facts.asked
}

/**
 * What the reply lacks once the turn said how it stands: the person reads the
 * reply, not the call, so it has to be there, watched or not: an empty answer
 * helps nobody. A question has to be asked in it too, but that is named only
 * while nobody has the session open (`clients` is 0): someone who reads along
 * asks back themselves. `reply` is the visible text written after the call.
 */
export function missingReply(facts: { called: boolean; questions: boolean; reply: string; clients: number }): Array<'reply' | 'questions'> {
  if (!facts.called) return []
  const text = facts.reply.trim()
  const unasked = facts.questions && facts.clients === 0 && !/\?|^\s*\d+[.)]\s/m.test(text)
  return [...(text === '' ? ['reply' as const] : []), ...(unasked ? ['questions' as const] : [])]
}

/** A turn ended: what it leaves when a session that works on its own still said nothing. Unclear means someone should look. */
export function attentionAfterTurn(facts: TurnFacts & { reason: 'success' | 'error' | 'interrupted' }): Attention | null {
  if (!facts.alone || facts.clients > 0 || facts.declared || facts.reason === 'interrupted') return null
  return facts.reason === 'error' ? 'failed' : 'review'
}

/** Where the board saw a session's task stand: open or not, the sessions its waits came from, and when it looked. */
export interface TaskWaitsSeen {
  open: boolean
  /** The sessions whose turn put a wait on the task (a wait's session_id, else its id). */
  sessions: ReadonlySet<string>
  /** When the board read the task (ISO). */
  at: string
}

/**
 * Whether a session still waits for someone, as the lists show it. The session keeps why its last turn stopped
 * (`attention`), and the router turns that into a wait on its task (application/task-router.ts). Once it has, the task
 * is the one source: a closed task waits on nobody, a reopen clears its waits, and a wait the owner answered is gone. So
 * a session on a task the board holds waits only while the task still has its wait. The session's own mark counts
 * alone where the task cannot say: no task, a task the board does not hold, or a mark the router has not carried over
 * yet (`unrouted`, or set after the board last read the task). On an open task only what asks for an answer (question,
 * failed) is checked against its waits: the router always makes those a wait, while a review or done it may leave out.
 */
export function attentionShown<A extends { kind: WorkerStatus; at: string }>(
  attention: A | null, facts: { unrouted: boolean; task: TaskWaitsSeen | null; sessionId: string },
): A | null {
  const { task } = facts
  if (!attention || !task || facts.unrouted || attention.at > task.at) return attention
  if (!task.open) return null
  if (!needsAnswer(attention.kind)) return attention
  return task.sessions.has(facts.sessionId) ? attention : null
}
