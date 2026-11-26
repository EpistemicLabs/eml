import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace, BrainSpaces } from '../brain-space.js'
import { needsAnswer, wasSpawned, worksAlone } from '../domain/session-attention.js'
import { reminder, type EndTurnAccess } from '../domain/turn-end.js'
import { sameWaits, waitsBody, waitsOf, withSessionWait } from '../domain/task-waits.js'
import type { SessionLedger } from '../session-ledger.js'
import { trackWaits } from './task-waits.js'

/**
 * The next-step check (decision agent-schedules-own-follow-ups-cockpit-guarantees):
 * the agent decides whether and when to check again; the cockpit only makes
 * sure no task handed to an agent goes silent. When a session's turn ended and
 * its task is still open, the task needs at least one next trigger:
 *
 *   - a wait this session set since its run began, on whomever (the user, another
 *     member, someone outside), or one on the user set by a newer run (an older
 *     wait answered() should have cleared does not count);
 *   - a job of the task that will run again (a next run, a channel that wakes
 *     it, or a run waiting to start); the check an end_turn call sets with
 *     next.when is such a job (application/turn-check.ts);
 *   - another session on the task that is working, or one of the user's own
 *     (not a worker): the task is in their conversation;
 *   - a step of the task the runner can move: active, or planned with a
 *     checkpoint and a delegate, and dependencies that can still resolve,
 *     under an active task.
 *
 * None: the session gets the one reminder of its stop (domain/turn-end.ts,
 * reminder next). Still none once that turn ended: the task waits on the user,
 * "Agent stopped without a next step". A turn the chat already sent back
 * (chat-bridge.ts onTurnEnding) had its reminder: it gets no second one, and
 * the task waits on the user at once.
 *
 * Who is checked: a session that works on its own (domain/session-attention.ts
 * worksAlone): its task is handed to an agent (the task names a delegate),
 * whoever started the session, or a session or a job started it as a worker.
 *
 * Watching is seeing: a session open in a pane counts as watched only once the
 * user has seen its answer (readAt, set when its desk is on screen in a
 * focused window). One they have not seen for UNSEEN_GRACE_MS is checked on
 * the runner's tick, a pane left open on a desk or not; one they saw is put
 * off until its pane is closed, and a nudge from before they looked in is void.
 *
 * Any other session on a task is the user's conversation (a desk session): no
 * trigger is required of it and it gets no reminder. An answer they have not
 * opened shows as unread; a question reaches the Inbox when the session
 * declares it (decision session-kind-follows-task-delegate).
 *
 * A job's worker that ended done with only its next run ahead rescheduled
 * quietly: it leaves the lists (quiet), its handoff is the journal entry.
 * The task is read anew at every check, so one closed or handed over while the
 * session was in its turn is seen as it is now. The marks are in memory: a
 * restart forgets them, and the next turn starts over.
 */

export const NO_NEXT_STEP = 'Agent stopped without a next step'
/** How long an answer stays unseen before the user counts as not watching it. */
export const UNSEEN_GRACE_MS = 30_000
// The read mark the page sends for an answer landing on screen can beat the turn's end to the host.
const SEEN_SLACK_MS = 5_000

/** wait: someone is waited on (the user, or whomever this session named). */
export type Trigger = 'wait' | 'job' | 'session' | 'step'

export interface JobFacts {
  /** It ended (finished, or its end came). */
  ended: boolean
  /** Paused, or waiting for the user's approval. */
  held: boolean
  nextRunAt: string | null
  /** A mail, Slack or WhatsApp trigger wakes it. */
  channel: boolean
  /** A run of it waits to start. */
  runWaiting: boolean
}

export interface StepFacts {
  status: string
  checkpoint?: string
  /** An agent is its delegate: the runner may start it. */
  delegated: boolean
  /** Every dependency is open or resolved (an invalidated one never resolves). */
  depsCanResolve: boolean
}

interface Task {
  id: string
  status: string
  properties?: { checkpoint?: string; depends_on?: string[]; assignee_ids?: string[]; delegate?: string; waits?: unknown; waiting_on?: unknown }
  relations?: Array<{ source_id: string; target_id: string; relation: string }>
}

/** The next triggers the task has after this run; empty when it has none. Pure, for the tests. */
export function nextTriggers(facts: {
  task: Pick<Task, 'status' | 'properties'>
  owner: string
  /** The session that is checked: a wait it set counts, whomever it is on. */
  sessionId: string
  /** When this session's run began: a wait from before it does not count. */
  runStartedAt: string
  jobs: JobFacts[]
  /** Another session holds the task: working on it, or the user's own. */
  otherSession: boolean
  steps: StepFacts[]
}): Trigger[] {
  const found: Trigger[] = []
  const counts = (w: { id: string; who: string; session_id?: string }) => w.who === facts.owner || (w.session_id ?? w.id) === facts.sessionId
  if (waitsOf(facts.task.properties).some((w) => counts(w) && (w.since ?? '') >= facts.runStartedAt)) found.push('wait')
  if (facts.jobs.some((j) => !j.ended && !j.held && (j.nextRunAt !== null || j.channel || j.runWaiting))) found.push('job')
  if (facts.otherSession) found.push('session')
  const runnable = (s: StepFacts) => s.status === 'active'
    || (s.status === 'planned' && Boolean(s.checkpoint) && s.delegated && s.depsCanResolve && facts.task.status === 'active')
  if (facts.steps.some(runnable)) found.push('step')
  return found
}

export interface NextStepDeps {
  ledger: Pick<SessionLedger, 'get' | 'list' | 'setAttention'>
  spaces: Pick<BrainSpaces, 'resolve'>
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /** The handle of the person whose turn it becomes (config handle). */
  owner: string
  /** The jobs attached to the task (domain/job.ts taskId). */
  jobsOf(taskId: string): JobFacts[]
  /** When the session's current run began: its job run's start, else its creation. */
  runStartedAt(sessionId: string): string
  /** Whether and how the session can call end_turn (application/turn-context.ts endTurnAccess); one that cannot is pointed at the block. */
  endTurnTool(sessionId: string): EndTurnAccess
  /** The session is in a turn now (for another session on the task, and on the tick). */
  working(sessionId: string): boolean
  /** The session is open in a pane (a chat view or terminal attached); not that the user looks at it. */
  watched(sessionId: string): boolean
  /** The user has seen the session since `since` (ISO time): its read mark is that new. */
  seen(sessionId: string, since: string): boolean
  /** Send the session a message (wakes a stopped one); false when it did not arrive. */
  deliver(sessionId: string, text: string): Promise<boolean>
  /** The session is flagged for the user: it shows as a new result until seen (decision desk-dot-until-seen). */
  waiting(sessionId: string): void
  /** A job's worker that only rescheduled: it leaves the lists. */
  quiet?(sessionId: string): void
  log(line: string): void
  now?: () => Date
}

export interface TurnFacts {
  /** When the turn ended (ISO time), taken before the router's write. */
  endedAt: string
  /** The chat already sent the turn back once (chat-bridge.ts onTurnEnding): it gets no second reminder. */
  reminded?: boolean
}

export interface NextStepCheck {
  /** A session's turn ended (after the router wrote its handoff). Never throws. */
  turnEnded(sessionId: string, turn?: TurnFacts): Promise<void>
  /** Check the sessions put off while the user watched them, or whose answer they have not seen yet. Never throws. */
  tick(): Promise<void>
}

export function createNextStepCheck(deps: NextStepDeps): NextStepCheck {
  const now = () => deps.now?.() ?? new Date()
  // The session was reminded for this task; its next stop without a trigger puts the task on the user.
  const nudged = new Map<string, string>()
  // Put off while the user had the session open, or until its answer was unseen long enough.
  const later = new Set<string>()
  // The session's last turn: since when its answer counts as seen, and whether the chat already sent it back.
  const ended = new Map<string, { at: string; reminded: boolean }>()
  const seenSince = (sessionId: string, turn: { at: string }) => deps.seen(sessionId, new Date(Date.parse(turn.at) - SEEN_SLACK_MS).toISOString())
  const unseenLong = (sessionId: string) => {
    const turn = ended.get(sessionId)
    return Boolean(turn) && !seenSince(sessionId, turn!) && now().getTime() - Date.parse(turn!.at) >= UNSEEN_GRACE_MS
  }

  const check = async (sessionId: string) => {
    const entry = deps.ledger.get(sessionId)
    // Sessions on a task in the brain; project leads are the user's.
    if (!entry?.taskId || entry.leadOf || entry.archivedAt) {
      later.delete(sessionId)
      return
    }
    const space = deps.spaces.resolve(entry.spaceId)
    const brain = deps.brain(space)
    if (!brain) return
    // Read now, not kept from the turn's end: another session may have closed the task or handed it over since.
    const task = await brain.get(`/engram/${entry.taskId}`, { with_relations: 'true' }) as Task
    if (task.status !== 'planned' && task.status !== 'active') {
      nudged.delete(sessionId)
      later.delete(sessionId)
      return
    }
    // The user's conversation: nothing is required of it.
    if (!worksAlone({ delegated: Boolean(task.properties?.delegate), worker: entry.worker, spawned: wasSpawned(entry) })) {
      nudged.delete(sessionId)
      later.delete(sessionId)
      return
    }
    // Open in a pane: theirs to steer once they have seen it (a nudge from before is void);
    // not seen yet, it waits out the grace, then counts as not watched.
    const turn = ended.get(sessionId)
    if (deps.watched(sessionId) && !unseenLong(sessionId)) {
      later.add(sessionId)
      if (!turn || seenSince(sessionId, turn)) nudged.delete(sessionId)
      return
    }
    later.delete(sessionId)

    const get = (id: string) => (brain.get(`/engram/${id}`) as Promise<Task>).catch(() => null)
    const childIds = (task.relations ?? []).filter((r) => r.relation === 'part_of' && r.target_id === task.id).map((r) => r.source_id)
    const steps: StepFacts[] = []
    for (const child of await Promise.all(childIds.map(get))) {
      if (!child) continue
      const depTasks = child.status === 'planned' ? await Promise.all((child.properties?.depends_on ?? []).map(get)) : []
      steps.push({
        status: child.status,
        checkpoint: child.properties?.checkpoint,
        delegated: Boolean(child.properties?.delegate),
        depsCanResolve: depTasks.every((d) => d !== null && ['planned', 'active', 'resolved'].includes(d.status)),
      })
    }
    const otherSession = deps.ledger.list().some((e) => e.sessionId !== sessionId && e.taskId === task.id && !e.archivedAt
      && (!e.worker || deps.working(e.sessionId)))
    const triggers = nextTriggers({ task, owner: deps.owner, sessionId, runStartedAt: deps.runStartedAt(sessionId), jobs: deps.jobsOf(task.id), otherSession, steps })

    if (triggers.length > 0) {
      nudged.delete(sessionId)
      // Rescheduled and nobody is waited on: the journal has its handoff, the lists don't need it.
      if (entry.jobId && triggers.includes('job') && !triggers.includes('wait') && entry.attention?.kind === 'done') {
        deps.quiet?.(sessionId)
        deps.log(`[next-step] ${sessionId.slice(0, 8)} task=${task.id.slice(0, 8)} rescheduled quietly`)
      }
      return
    }
    // The session already asks for the user (question, failure): the router put it in Your turn.
    if (entry.attention && needsAnswer(entry.attention.kind)) return
    // One reminder per stop: a turn the chat sent back already had it.
    if (!turn?.reminded && nudged.get(sessionId) !== task.id) {
      nudged.set(sessionId, task.id)
      const arrived = await deps.deliver(sessionId, reminder(['next'], { tool: deps.endTurnTool(sessionId) })).catch(() => false)
      deps.log(`[next-step] ${sessionId.slice(0, 8)} task=${task.id.slice(0, 8)} has no next step: ${arrived ? 'reminded' : 'reminder not delivered'}`)
      if (arrived) return
    }
    nudged.delete(sessionId)
    // The session's wait in the task's waits: the waits of other sessions stay.
    const stopped = { who: deps.owner, kind: 'stopped', why: NO_NEXT_STEP, since: now().toISOString(), session_id: sessionId }
    await trackWaits(brain, task.id, (t) => {
      const waits = waitsOf(t.properties)
      const after = withSessionWait(waits, stopped)
      return sameWaits(after, waits) ? null : waitsBody(after)
    })
    deps.ledger.setAttention(sessionId, { kind: 'question', reason: NO_NEXT_STEP })
    deps.waiting(sessionId)
    deps.log(`[next-step] ${sessionId.slice(0, 8)} task=${task.id.slice(0, 8)} waits on ${deps.owner}: ${NO_NEXT_STEP}`)
  }

  const safely = async (sessionId: string) => {
    try {
      await check(sessionId)
    } catch (err) {
      deps.log(`[next-step] ${sessionId.slice(0, 8)} failed: ${(err as Error).message}`)
    }
  }

  return {
    async turnEnded(sessionId, turn) {
      ended.set(sessionId, { at: turn?.endedAt ?? now().toISOString(), reminded: turn?.reminded ?? false })
      await safely(sessionId)
    },
    async tick() {
      // One in a turn again is checked when that turn ends.
      for (const sessionId of [...later]) if (!deps.working(sessionId)) await safely(sessionId)
    },
  }
}
