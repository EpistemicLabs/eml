import type { EmlApi } from '@engramprotocol/mcp-server'
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
 * One follow per session at a time; a follow that finds nothing to do writes nothing.
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

/** What became of a hand-over to the replacing task: given to its holder, the session moved after all, or only journaled. */
export type HandOverOutcome = 'delivered' | 'moved' | 'journaled'

export interface FollowReplacement {
  follow(sessionId: string): Promise<FollowOutcome>
  handOver(sessionId: string, held: Extract<FollowOutcome, { kind: 'held' }>, block: string): Promise<HandOverOutcome>
  /** The board read these tasks as replaced: each live session on one follows (in the background). */
  sweep(replacedTaskIds: readonly string[]): void
}

type Task = ReplaceableTask & { title?: string | null; properties?: { display_title?: string } }

export function createFollowReplacement(deps: FollowReplacementDeps): FollowReplacement {
  const running = new Map<string, Promise<FollowOutcome>>()

  const nameOf = (sessionId: string) => {
    const entry = deps.ledger.get(sessionId)
    return entry ? `"${holderName({ ...entry, sessionId })}" (${sessionId})` : sessionId
  }
  const brainOf = (sessionId: string) => {
    const entry = deps.ledger.get(sessionId)
    return entry ? deps.brain(deps.spaces.resolve(entry.spaceId)) : null
  }
  const journal = async (brain: Pick<EmlApi, 'post'>, taskId: string, text: string) => {
    try {
      await brain.post(`/task/${encodeURIComponent(taskId)}/track`, { text })
    } catch (err) {
      deps.log(`[follow] journal of task ${taskId.slice(0, 8)} not written: ${(err as Error).message}`)
    }
  }

  const move = async (sessionId: string, from: string, to: Task, brain: Pick<EmlApi, 'post'>): Promise<FollowOutcome> => {
    deps.ledger.setTask(sessionId, to.id)
    deps.log(`[follow] ${sessionId.slice(0, 8)} moved from replaced task ${from.slice(0, 8)} to ${to.id.slice(0, 8)}`)
    const name = nameOf(sessionId)
    await Promise.all([journal(brain, to.id, movedHereText(name, from)), journal(brain, from, movedAwayText(name, to.id))])
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
    const read = (id: string) => brain.get(`/engram/${encodeURIComponent(id)}`, { with_relations: 'true' }) as Promise<Task | null>
    const task = await read(from).catch(() => null)
    if (task?.status !== 'superseded') return { kind: 'stays' }
    const replacement = await findReplacement(read, task)
    if (replacement.kind !== 'open') {
      deps.log(`[follow] ${sessionId.slice(0, 8)} stays on replaced task ${from.slice(0, 8)}: ${replacement.kind === 'none' ? 'no open task replaced it' : `several open tasks replaced it (${replacement.taskIds.map((id) => id.slice(0, 8)).join(', ')})`}`)
      return { kind: 'stays' }
    }
    const to = await read(replacement.taskId).catch(() => null)
    if (!to) return { kind: 'stays' }
    const decision = followDecision(sessionId, leaseHolder(deps.pending(), leaseSessions(deps.ledger.list()), to.id))
    if (decision.kind === 'move') return move(sessionId, from, to, brain)
    const holder = decision.holder.kind === 'session' ? decision.holder.sessionId : decision.holder.requestId
    return { kind: 'held', from, to: to.id, holder }
  }

  const follow = (sessionId: string): Promise<FollowOutcome> => {
    const known = running.get(sessionId)
    if (known) return known
    const work = run(sessionId)
      .catch((err) => { deps.log(`[follow] ${sessionId.slice(0, 8)} failed: ${(err as Error).message}`); return { kind: 'stays' } as FollowOutcome })
      .finally(() => running.delete(sessionId))
    running.set(sessionId, work)
    return work
  }

  return {
    follow,

    async handOver(sessionId, held, block) {
      const brain = brainOf(sessionId)
      if (!brain) return 'journaled'
      const text = handedOverText(nameOf(sessionId), held.from, block)
      const routed = await routeToTaskHolder({
        pending: deps.pending, sessions: () => deps.ledger.list(), deliver: deps.deliver,
        ...(deps.contextTokensOf ? { contextTokensOf: deps.contextTokensOf } : {}),
        ...(deps.putAway ? { putAway: deps.putAway } : {}),
      }, { taskId: held.to, prompt: text, fromSessionId: sessionId, from: null })
      if (routed.kind === 'free') {
        // The holder made way (put away for its very long context) or left meanwhile: the session goes on there.
        const to = await (brain.get(`/engram/${encodeURIComponent(held.to)}`) as Promise<Task>).catch(() => ({ id: held.to, status: 'active' }))
        await move(sessionId, held.from, to, brain)
        return 'moved'
      }
      await journal(brain, held.to, text)
      if (routed.kind === 'routed') {
        deps.log(`[follow] ${sessionId.slice(0, 8)} hand-over went to ${routed.session.sessionId.slice(0, 8)} on task ${held.to.slice(0, 8)}`)
        return 'delivered'
      }
      deps.log(`[follow] ${sessionId.slice(0, 8)} hand-over is in task ${held.to.slice(0, 8)}'s journal only: ${routed.refusal.message}`)
      return 'journaled'
    },

    sweep(replacedTaskIds) {
      if (replacedTaskIds.length === 0) return
      const replaced = new Set(replacedTaskIds)
      for (const entry of deps.ledger.list()) {
        if (entry.taskId && replaced.has(entry.taskId) && !entry.archivedAt && !entry.jobId) void follow(entry.sessionId)
      }
    },
  }
}
