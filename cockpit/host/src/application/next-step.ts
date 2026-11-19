import type { EmlApi } from '@engramprotocol/mcp-server'
import { taskSystemOn, type BrainSpace, type BrainSpaces } from '../brain-space.js'
import { needsAnswer } from '../domain/session-attention.js'
import type { SessionLedger } from '../session-ledger.js'

/**
 * The next-step check (decision agent-schedules-own-follow-ups-cockpit-guarantees):
 * the agent decides whether and when to check again; the cockpit only makes
 * sure no delegated task goes silent. In a space with the task system on, when
 * a worker's turn ended and its task is still open, the task needs at least
 * one next trigger:
 *
 *   - a question or review waiting on the user, set by this run or a newer one
 *     (an older wait answered() should have cleared does not count);
 *   - a job of the task that will run again (a next run, a channel that wakes
 *     it, or a run waiting to start);
 *   - another session on the task that is working, or one of the user's own
 *     (not a worker): the task is in their conversation;
 *   - a step of the task the runner can move: active, or planned with a
 *     checkpoint and a delegate, and dependencies that can still resolve,
 *     under an active task.
 *
 * None: the session gets one short prompt (NEXT_STEP_PROMPT). Still none once
 * that turn ended: the task waits on the user, "Agent stopped without a next
 * step". A worker the user has open is not prompted mid-conversation; it is
 * checked again on the runner's tick once nobody watches it, and a nudge from
 * before the user looked in is void.
 *
 * A job's worker that ended done with only its next run ahead rescheduled
 * quietly: it leaves the lists (quiet), its handoff is the journal entry.
 * The user's own sessions are never checked. The nudge marks are in memory:
 * a restart forgets them, and the next turn starts over.
 */

export const NEXT_STEP_PROMPT = 'Your task is still open but has no next step. Set a check, ask Lasse, or close the task.'
export const NO_NEXT_STEP = 'Agent stopped without a next step'

export type Trigger = 'question' | 'job' | 'session' | 'step'

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
  properties?: { checkpoint?: string; depends_on?: string[]; assignee_ids?: string[]; delegate?: string; waiting_on?: Record<string, string> }
  relations?: Array<{ source_id: string; target_id: string; relation: string }>
}

/** The next triggers the task has after this run; empty when it has none. Pure, for the tests. */
export function nextTriggers(facts: {
  task: Pick<Task, 'status' | 'properties'>
  owner: string
  /** When this session's run began: a wait from before it does not count. */
  runStartedAt: string
  jobs: JobFacts[]
  /** Another session holds the task: working on it, or the user's own. */
  otherSession: boolean
  steps: StepFacts[]
}): Trigger[] {
  const found: Trigger[] = []
  const waiting = facts.task.properties?.waiting_on
  if (waiting?.who === facts.owner && (waiting.since ?? '') >= facts.runStartedAt) found.push('question')
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
  /** The session is in a turn now (for another session on the task, and on the tick). */
  working(sessionId: string): boolean
  /** The user has the session open (a chat view or terminal attached). */
  watched(sessionId: string): boolean
  /** Send the session a message (wakes a stopped one); false when it did not arrive. */
  deliver(sessionId: string, text: string): Promise<boolean>
  /** The session now waits for the user: its turn state shows it. */
  waiting(sessionId: string): void
  /** A job's worker that only rescheduled: it leaves the lists. */
  quiet?(sessionId: string): void
  log(line: string): void
  now?: () => Date
}

export interface NextStepCheck {
  /** A session's turn ended (after the router wrote its handoff). Never throws. */
  turnEnded(sessionId: string): Promise<void>
  /** Check the sessions put off while the user watched them. Never throws. */
  tick(): Promise<void>
}

export function createNextStepCheck(deps: NextStepDeps): NextStepCheck {
  const now = () => deps.now?.() ?? new Date()
  // The session was prompted for this task; its next stop without a trigger puts the task on the user.
  const nudged = new Map<string, string>()
  // Put off while the user had the session open.
  const later = new Set<string>()

  const check = async (sessionId: string) => {
    const entry = deps.ledger.get(sessionId)
    // Only delegated work: a worker on a task in the brain; the user's own sessions and project leads are theirs.
    if (!entry?.worker || !entry.taskId || entry.leadOf || entry.archivedAt) return
    const space = deps.spaces.resolve(entry.spaceId)
    if (!taskSystemOn(space)) return
    const brain = deps.brain(space)
    if (!brain) return
    // The user is in the conversation: theirs to steer; a nudge from before it is void.
    if (deps.watched(sessionId)) {
      later.add(sessionId)
      nudged.delete(sessionId)
      return
    }
    later.delete(sessionId)

    const task = await brain.get(`/engram/${entry.taskId}`, { with_relations: 'true' }) as Task
    if (task.status !== 'planned' && task.status !== 'active') {
      nudged.delete(sessionId)
      return
    }
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
    const triggers = nextTriggers({ task, owner: deps.owner, runStartedAt: deps.runStartedAt(sessionId), jobs: deps.jobsOf(task.id), otherSession, steps })

    if (triggers.length > 0) {
      nudged.delete(sessionId)
      // Rescheduled and nothing for the user: the journal has its handoff, the lists don't need it.
      if (entry.jobId && triggers.includes('job') && !triggers.includes('question') && entry.attention?.kind === 'done') {
        deps.quiet?.(sessionId)
        deps.log(`[next-step] ${sessionId.slice(0, 8)} task=${task.id.slice(0, 8)} rescheduled quietly`)
      }
      return
    }
    // The session already asks for the user (question, failure): the router put it in Your turn.
    if (entry.attention && needsAnswer(entry.attention.kind)) return
    if (nudged.get(sessionId) !== task.id) {
      nudged.set(sessionId, task.id)
      const arrived = await deps.deliver(sessionId, NEXT_STEP_PROMPT).catch(() => false)
      deps.log(`[next-step] ${sessionId.slice(0, 8)} task=${task.id.slice(0, 8)} has no next step: ${arrived ? 'prompted' : 'prompt not delivered'}`)
      if (arrived) return
    }
    nudged.delete(sessionId)
    await brain.post(`/task/${task.id}/track`, { waiting_on: { who: deps.owner, kind: 'stopped', why: NO_NEXT_STEP, since: now().toISOString(), session_id: sessionId } })
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
    turnEnded: safely,
    async tick() {
      // One in a turn again is checked when that turn ends.
      for (const sessionId of [...later]) if (!deps.watched(sessionId) && !deps.working(sessionId)) await safely(sessionId)
    },
  }
}
