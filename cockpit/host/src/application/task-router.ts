import * as fs from 'node:fs'
import type { EmlApi } from '@engramprotocol/mcp-server'
import { taskSystemOn, type BrainSpace, type BrainSpaces } from '../brain-space.js'
import { parseHandoff, type Handoff } from '../domain/handoff.js'
import { needsAnswer } from '../domain/session-attention.js'
import type { SessionLedger } from '../session-ledger.js'

/**
 * The router (decision one-router-for-steps-and-jobs): when a session's turn
 * ends in a space with the task system on, it decides whose turn it is and
 * writes that into the session's task.
 *
 *   - The session's handoff (domain/handoff.ts) goes into the task's history.
 *   - A question for the user, or a session that said question or failed
 *     (session_status), puts the task on the user: waiting_on { who, why,
 *     since, session_id } — the Your turn panel lists it and opens the session.
 *   - A step with checkpoint "after" that handed over a result waits for the
 *     user's review the same way.
 *   - Anything else clears a waiting_on this session set: the work goes on.
 *   - A session that closed its task and asks nothing is finished: its
 *     handoff and outcome are in the task, so it leaves the lists (finished).
 *
 * The session never sets waiting_on itself (it is not among its tools); a job's
 * session is routed like any other, so a job needs no notify setting of its own.
 * A turn without a handoff and without a status changes nothing, and the same
 * handoff twice is written once.
 */

export interface TaskRouterDeps {
  ledger: Pick<SessionLedger, 'get' | 'setAttention'>
  spaces: Pick<BrainSpaces, 'resolve'>
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /** The handle of the person whose turn it becomes (config handle). */
  owner: string
  /** The session now waits for the user: its turn state shows it (turn-state.ts). */
  waiting(sessionId: string): void
  /** The session closed its task and nobody waits: its work is in the task's history (auto-archive). */
  finished?(sessionId: string): void
  log(line: string): void
  now?: () => Date
}

interface Task {
  id: string
  status: string
  properties?: { checkpoint?: string; waiting_on?: Record<string, string> }
}

export interface WaitingOn {
  who: string
  why: string
  since: string
  session_id: string
}

/** Whose turn it is after this turn; null when nobody waits. Pure, for the tests. */
export function decideWaiting(facts: {
  handoff: Handoff | null
  attention: { kind: string; reason: string | null } | null
  checkpoint: string | undefined
  owner: string
  sessionId: string
  now: Date
}): WaitingOn | null {
  const { handoff, attention } = facts
  const wait = (why: string): WaitingOn => ({ who: facts.owner, why: why.slice(0, 300), since: facts.now.toISOString(), session_id: facts.sessionId })
  if (handoff && handoff.forUser.length > 0) return wait(handoff.forUser.join(' · '))
  if (attention && needsAnswer(attention.kind as never)) return wait(attention.reason ?? (attention.kind === 'failed' ? 'The session failed' : 'The session has a question'))
  if (facts.checkpoint === 'after' && (handoff?.result || attention?.kind === 'review')) return wait(`Review: ${handoff?.result ?? attention?.reason ?? 'the result'}`)
  return null
}

export interface TaskRouter {
  /** A session's turn ended; `message` is its last reply. Never throws. */
  turnEnded(sessionId: string, message: string): Promise<void>
}

export function createTaskRouter(deps: TaskRouterDeps): TaskRouter {
  const now = () => deps.now?.() ?? new Date()
  // What was last routed per session, so a turn that changed nothing writes nothing.
  const lastRouted = new Map<string, string>()

  const route = async (sessionId: string, message: string) => {
    const entry = deps.ledger.get(sessionId)
    if (!entry?.taskId) return
    const space = deps.spaces.resolve(entry.spaceId)
    if (!taskSystemOn(space)) return
    const brain = deps.brain(space)
    if (!brain) return

    const handoff = parseHandoff(message)
    const attention = entry.attention
    if (!handoff && !attention) return
    // The handoff, or without one the status: not the question the router itself put on the session.
    const key = handoff ? handoff.text : `${attention!.kind}:${attention!.reason ?? ''}`
    if (lastRouted.get(sessionId) === key) return

    const task = await brain.get(`/engram/${entry.taskId}`) as Task
    if (task.status !== 'planned' && task.status !== 'active') {
      lastRouted.set(sessionId, key)
      const asks = (handoff?.forUser.length ?? 0) > 0 || (attention !== null && needsAnswer(attention.kind))
      if (!asks) {
        deps.finished?.(sessionId)
        deps.log(`[router] ${sessionId.slice(0, 8)} task=${task.id.slice(0, 8)} closed, finished`)
      }
      return
    }
    const waiting = decideWaiting({ handoff, attention, checkpoint: task.properties?.checkpoint, owner: deps.owner, sessionId, now: now() })
    const current = task.properties?.waiting_on
    // Another session's wait stays until that session or the user moves on.
    const clear = !waiting && current?.session_id === sessionId
    const patch: Record<string, unknown> = {}
    if (handoff) patch.text = handoff.text
    if (waiting && (current?.why !== waiting.why || current?.session_id !== sessionId)) patch.waiting_on = waiting
    if (clear) patch.waiting_on = null
    lastRouted.set(sessionId, key)
    if (Object.keys(patch).length === 0) return
    await brain.post(`/task/${task.id}/track`, patch)
    // The session waits for the user too, so it is at the top of Your turn and the push says so.
    if (waiting && !(attention && needsAnswer(attention.kind))) {
      deps.ledger.setAttention(sessionId, { kind: 'question', reason: waiting.why })
      deps.waiting(sessionId)
    }
    deps.log(`[router] ${sessionId.slice(0, 8)} task=${task.id.slice(0, 8)} ${waiting ? `waiting on ${waiting.who}` : clear ? 'cleared' : 'handoff'}`)
  }

  return {
    async turnEnded(sessionId, message) {
      try {
        await route(sessionId, message)
      } catch (err) {
        deps.log(`[router] ${sessionId.slice(0, 8)} failed: ${(err as Error).message}`)
      }
    },
  }
}

/** How much of a transcript's end is read for the last reply. */
const TAIL_BYTES = 512 * 1024

/**
 * The last reply of a terminal session from its Stop hook: the payload's
 * last_assistant_message (Claude Code, Codex), else the last assistant text in
 * the transcript it names (Claude Code's JSONL). Empty when neither has one.
 */
export function replyFromStopHook(payload: Record<string, unknown>): string {
  if (typeof payload.last_assistant_message === 'string') return payload.last_assistant_message
  const file = payload.transcript_path
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return ''
  let tail: string
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const length = Math.min(size, TAIL_BYTES)
      const buf = Buffer.alloc(length)
      fs.readSync(fd, buf, 0, length, size - length)
      tail = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
  for (const line of tail.split('\n').reverse()) {
    if (!line.includes('"assistant"')) continue
    try {
      const record = JSON.parse(line) as { type?: string; message?: { content?: unknown } }
      if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) continue
      const text = (record.message.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
      if (text.trim()) return text
    } catch { /* a line cut off at the start of the tail */ }
  }
  return ''
}
