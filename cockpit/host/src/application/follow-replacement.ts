import { EmlApiError, type EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace, BrainSpaces } from '../brain-space.js'
import type { SessionLedger } from '../session-ledger.js'
import type { DeliveryOutcome } from '../domain/session-delivery.js'
import type { SpawnRequest } from '../domain/spawn-request.js'
import { holderName, leaseHolder, leaseSessions } from '../domain/task-lease.js'
import { findReplacement, followDecision, handedOverText, movedAwayText, movedHereText, movedNotice, type ReplaceableTask } from '../domain/task-replacement.js'
import { routeToTaskHolder, type RouteDeps } from './task-lease.js'
import type { MessageRequest } from './deliver-message.js'

/**
 * A live session whose task was replaced goes on where the work went (domain/task-replacement.ts has the rule).
 *
 *   follow    the board saw the task replaced, or the router is about to route a turn: move the session onto the
 *             replacement when nobody else holds it, with a line in both journals and, when the session is in a turn,
 *             a notice it reads in that turn;
 *   handOver  a turn ended while another session holds the replacement: the hand-over goes into the replacing task's
 *             journal and to the holder as a message (application/task-lease.ts routeToTaskHolder). A holder whose
 *             context is very long is put away instead, and the session moves.
 *
 * Both run one at a time per session. Every write is keyed on what the journal already holds, so a call made again
 * (the board's sweep beside the router, a turn routed again after a restart, application/unrouted-turns.ts) writes
 * nothing twice: the journal lines of a move are written before the ledger moves, and the move is the last step; a
 * hand-over already in the replacing task's journal is neither written nor delivered again. The message to the holder
 * goes out before its journal line, so only a stop between the two can deliver it twice; the notice to the moved
 * session accompanies the move and is sent once, after it.
 *
 * A brain that does not answer throws (outcome 'failed' from follow): the router then leaves the turn unrouted, and the
 * next try routes it, instead of reading a brain error as "nothing replaced it".
 */

export interface FollowReplacementDeps {
  ledger: Pick<SessionLedger, 'get' | 'list' | 'setTask'>
  spaces: Pick<BrainSpaces, 'resolve'>
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  pending(): readonly SpawnRequest[]
  /** The session is in a turn now: a notice reaches it in that turn instead of starting one. */
  working(sessionId: string): boolean
  deliver(request: MessageRequest): Promise<DeliveryOutcome>
  contextTokensOf?: RouteDeps['contextTokensOf']
  putAway?: RouteDeps['putAway']
  log(line: string): void
}

export type FollowOutcome =
  | { kind: 'stays' }
  | { kind: 'moved'; from: string; to: string }
  | { kind: 'held'; from: string; to: string; holder: string }
  /** The brain did not answer: try again later. */
  | { kind: 'failed' }

/** What became of a hand-over to the replacing task: given to its holder, the session moved after all, or only journaled. */
export type HandOverOutcome = 'delivered' | 'moved' | 'journaled'

export interface FollowReplacement {
  follow(sessionId: string): Promise<FollowOutcome>
  /** Throws when the brain does not answer: the turn stays unrouted and is tried again. */
  handOver(sessionId: string, held: Extract<FollowOutcome, { kind: 'held' }>, block: string): Promise<HandOverOutcome>
  /** The board read these tasks as replaced: each live session on one follows (in the background). */
  sweep(replacedTaskIds: readonly string[]): void
}

type Task = ReplaceableTask & { title?: string | null; properties?: { display_title?: string }; entries?: Array<{ kind?: string; text?: string | null }> }
type Brain = Pick<EmlApi, 'get' | 'post'>

const notFound = (err: unknown) => err instanceof EmlApiError ? err.status === 404 : (err as { status?: number })?.status === 404

export function createFollowReplacement(deps: FollowReplacementDeps): FollowReplacement {
  // One follow or hand-over per session at a time; a follow asked for while one runs gets its answer.
  const tails = new Map<string, Promise<unknown>>()
  const following = new Map<string, Promise<FollowOutcome>>()
  // What the sweep found settled: a session that stays on its replaced task (no single open replacement) or waits for
  // the replacement's holder, per task. The board builds every few seconds, and that answer does not change by
  // itself; the router still checks again at each turn end.
  const settled = new Map<string, string>()
  const serial = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const run = (tails.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(work)
    const tail = run.catch(() => {})
    tails.set(sessionId, tail)
    void tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId) })
    return run
  }

  const nameOf = (sessionId: string) => {
    const entry = deps.ledger.get(sessionId)
    return entry ? `"${holderName({ ...entry, sessionId })}" (${sessionId})` : sessionId
  }
  const brainOf = (sessionId: string) => {
    const entry = deps.ledger.get(sessionId)
    return entry ? deps.brain(deps.spaces.resolve(entry.spaceId)) : null
  }
  /** The task with its relations and journal; null when the brain has no such task, a throw when it did not answer. */
  const read = (brain: Brain, id: string) =>
    (brain.get(`/engram/${encodeURIComponent(id)}`, { with_relations: 'true' }) as Promise<Task>).catch((err) => { if (notFound(err)) return null; throw err })
  const journaled = (task: Task | null, text: string) => Boolean(task?.entries?.some((e) => e.kind === 'note' && e.text === text))
  /** The note in the task's journal, written unless it is there already. */
  const journalOnce = async (brain: Brain, taskId: string, text: string) => {
    if (journaled(await read(brain, taskId), text)) return
    await brain.post(`/task/${encodeURIComponent(taskId)}/track`, { text })
  }

  const move = async (sessionId: string, from: string, to: Task, brain: Brain): Promise<FollowOutcome> => {
    const name = nameOf(sessionId)
    await journalOnce(brain, to.id, movedHereText(name, from))
    await journalOnce(brain, from, movedAwayText(name, to.id))
    // Something else moved it meanwhile: that move stands.
    const now = deps.ledger.get(sessionId)?.taskId ?? null
    if (now !== from) return now ? { kind: 'moved', from, to: now } : { kind: 'stays' }
    deps.ledger.setTask(sessionId, to.id)
    deps.log(`[follow] ${sessionId.slice(0, 8)} moved from replaced task ${from.slice(0, 8)} to ${to.id.slice(0, 8)}`)
    if (deps.working(sessionId)) {
      const title = to.properties?.display_title ?? to.title ?? null
      const outcome = await deps.deliver({ target: sessionId, text: movedNotice(from, to.id, title), from: null, caller: 'session' }).catch(() => 'unknown' as const)
      if (outcome !== 'delivered') deps.log(`[follow] ${sessionId.slice(0, 8)} notice not delivered: ${outcome}`)
    }
    return { kind: 'moved', from, to: to.id }
  }

  const run = async (sessionId: string): Promise<FollowOutcome> => {
    const entry = deps.ledger.get(sessionId)
    if (!entry?.taskId || entry.archivedAt || entry.jobId) return { kind: 'stays' }
    const brain = brainOf(sessionId)
    if (!brain) return { kind: 'stays' }
    const from = entry.taskId
    const task = await read(brain, from)
    if (task?.status !== 'superseded') return { kind: 'stays' }
    const replacement = await findReplacement((id) => read(brain, id), task)
    if (replacement.kind !== 'open') {
      deps.log(`[follow] ${sessionId.slice(0, 8)} stays on replaced task ${from.slice(0, 8)}: ${replacement.kind === 'none' ? 'no open task replaced it' : `several open tasks replaced it (${replacement.taskIds.map((id) => id.slice(0, 8)).join(', ')})`}`)
      return { kind: 'stays' }
    }
    const to = await read(brain, replacement.taskId)
    if (!to) return { kind: 'stays' }
    const decision = followDecision(sessionId, leaseHolder(deps.pending(), leaseSessions(deps.ledger.list()), to.id))
    if (decision.kind === 'move') return move(sessionId, from, to, brain)
    const holder = decision.holder.kind === 'session' ? decision.holder.sessionId : decision.holder.requestId
    return { kind: 'held', from, to: to.id, holder }
  }

  const follow = (sessionId: string): Promise<FollowOutcome> => {
    const known = following.get(sessionId)
    if (known) return known
    const work = serial(sessionId, () => run(sessionId))
      .catch((err) => { deps.log(`[follow] ${sessionId.slice(0, 8)} failed: ${(err as Error).message}`); return { kind: 'failed' } as FollowOutcome })
      .finally(() => following.delete(sessionId))
    following.set(sessionId, work)
    return work
  }

  const handOver = async (sessionId: string, held: Extract<FollowOutcome, { kind: 'held' }>, block: string): Promise<HandOverOutcome> => {
    const brain = brainOf(sessionId)
    if (!brain) return 'journaled'
    const text = handedOverText(nameOf(sessionId), held.from, block)
    const to = await read(brain, held.to)
    if (!to) return 'journaled'
    // A turn routed again whose hand-over landed before: it was delivered then.
    if (journaled(to, text)) return 'delivered'
    const routed = await routeToTaskHolder({
      pending: deps.pending, sessions: () => deps.ledger.list(), deliver: deps.deliver,
      ...(deps.contextTokensOf ? { contextTokensOf: deps.contextTokensOf } : {}),
      ...(deps.putAway ? { putAway: deps.putAway } : {}),
    }, { taskId: held.to, prompt: text, fromSessionId: sessionId, from: null })
    if (routed.kind === 'free') {
      // The holder made way (put away for its very long context) or left meanwhile: the session goes on there.
      await move(sessionId, held.from, to, brain)
      return 'moved'
    }
    await journalOnce(brain, held.to, text)
    if (routed.kind === 'routed') {
      deps.log(`[follow] ${sessionId.slice(0, 8)} hand-over went to ${routed.session.sessionId.slice(0, 8)} on task ${held.to.slice(0, 8)}`)
      return 'delivered'
    }
    deps.log(`[follow] ${sessionId.slice(0, 8)} hand-over is in task ${held.to.slice(0, 8)}'s journal only: ${routed.refusal.code}`)
    return 'journaled'
  }

  return {
    follow,
    handOver: (sessionId, held, block) => serial(sessionId, () => handOver(sessionId, held, block)),
    sweep(replacedTaskIds) {
      if (replacedTaskIds.length === 0) return
      const replaced = new Set(replacedTaskIds)
      for (const entry of deps.ledger.list()) {
        const taskId = entry.taskId
        if (!taskId || !replaced.has(taskId) || entry.archivedAt || entry.jobId || settled.get(entry.sessionId) === taskId) continue
        void follow(entry.sessionId).then((outcome) => {
          if (outcome.kind === 'stays' || outcome.kind === 'held') settled.set(entry.sessionId, taskId)
        })
      }
    },
  }
}
