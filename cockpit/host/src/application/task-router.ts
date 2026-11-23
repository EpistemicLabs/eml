import * as fs from 'node:fs'
import * as path from 'node:path'
import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace, BrainSpaces } from '../brain-space.js'
import { parseHandoff, type Handoff } from '../domain/handoff.js'
import { needsAnswer } from '../domain/session-attention.js'
import type { WaitKind } from '../domain/task-turn.js'
import type { SessionLedger } from '../session-ledger.js'
import { COCKPIT_HOME } from '../paths.js'

/**
 * The router (decision one-router-for-steps-and-jobs): when a session's turn
 * ends, it decides whose turn it is and
 * writes that into the session's task.
 *
 *   - The session's handoff (domain/handoff.ts) goes into the task's history.
 *   - A question for the user, or a session that said question or failed
 *     (session_status), puts the task on the user: waiting_on { who, why,
 *     since, session_id } — the Inbox lists it and opens the session. The
 *     session itself is not marked as waiting: it finished its turn, and the
 *     question is the task's (decision handoff-questions-inbox-only).
 *   - A step with checkpoint "after" that handed over a result, or any session
 *     that said review, waits for the user's review the same way.
 *   - Anything else clears a waiting_on this session set: the work goes on.
 *   - A wait another session set stays: while that session is not put
 *     away, this session's wait is held back, and it takes the other one's
 *     place once that is answered or cleared. Held waits are kept in a file
 *     (HeldWaitStore), so a host restart does not lose them.
 *   - A session that closed its task and asks nothing is finished: its
 *     handoff and outcome are in the task, so it leaves the lists (finished).
 *
 * The session never sets waiting_on itself (it is not among its tools); a job's
 * session is routed like any other, so a job needs no notify setting of its own.
 * A turn without a handoff and without a status changes nothing, and the same
 * handoff twice is written once.
 */

export interface TaskRouterDeps {
  ledger: Pick<SessionLedger, 'get'>
  spaces: Pick<BrainSpaces, 'resolve'>
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /** The handle of the person whose turn it becomes (config handle). */
  owner: string
  /** Where waits held back behind another session's wait are kept; in memory when not given. */
  held?: Pick<HeldWaitStore, 'get' | 'set'>
  /** The session closed its task and nobody waits: its work is in the task's history (auto-archive). */
  finished?(sessionId: string): void
  log(line: string): void
  now?: () => Date
}

interface Task {
  id: string
  status: string
  properties?: { checkpoint?: string; waiting_on?: Record<string, string> }
  /** The task's journal (the brain's /engram answer): a reopen is a change entry "reopened (…)". */
  entries?: Array<{ kind?: string; at?: string; text?: string }>
}

/** When the task was last reopened (board or chat), from its journal; null when never. */
export function reopenedAt(task: Pick<Task, 'entries'>): string | null {
  const last = (task.entries ?? []).filter((e) => e.kind === 'change' && typeof e.text === 'string' && e.text.startsWith('reopened') && e.at).at(-1)
  return last?.at ?? null
}

export interface WaitingOn {
  who: string
  /** question · go · review · stopped (domain/task-turn.ts WaitKind). */
  kind: WaitKind
  why: string
  since: string
  session_id: string
}

/** held-waits.json: the waits held back per task, oldest first. Read tolerantly, rewritten whole, owner-only. */
export class HeldWaitStore {
  private data: Record<string, WaitingOn[]> = {}

  constructor(readonly file = path.join(COCKPIT_HOME, 'held-waits.json')) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object') {
        for (const [taskId, waits] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(waits)) this.data[taskId] = waits.filter((w): w is WaitingOn => !!w && typeof w === 'object' && typeof (w as WaitingOn).session_id === 'string')
        }
      }
    } catch { /* none yet */ }
  }

  get(taskId: string): WaitingOn[] {
    return this.data[taskId] ?? []
  }

  set(taskId: string, waits: WaitingOn[]): void {
    if (waits.length) this.data[taskId] = waits
    else if (taskId in this.data) delete this.data[taskId]
    else return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}

/** A question as the Inbox shows it: up to its first question mark, at most 160 characters. */
export function shortQuestion(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const mark = flat.indexOf('?')
  const cut = mark >= 0 ? flat.slice(0, mark + 1) : flat
  return cut.length > 160 ? `${cut.slice(0, 159)}…` : cut
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
  const wait = (kind: WaitKind, why: string): WaitingOn => ({ who: facts.owner, kind, why: why.slice(0, 300), since: facts.now.toISOString(), session_id: facts.sessionId })
  // A step with checkpoint before asks before it acts: its question is the go.
  if (handoff && handoff.forUser.length > 0) return wait(facts.checkpoint === 'before' ? 'go' : 'question', handoff.forUser.map(shortQuestion).join(' · '))
  if (attention && needsAnswer(attention.kind as never)) {
    return attention.kind === 'failed' ? wait('stopped', attention.reason ?? 'The session failed') : wait('question', attention.reason ?? 'The session has a question')
  }
  // A session that says review hands a result over (its goal is reached), whatever the checkpoint.
  if (attention?.kind === 'review' || (facts.checkpoint === 'after' && handoff?.result)) return wait('review', `Review: ${handoff?.result ?? attention?.reason ?? 'the result'}`)
  return null
}

export interface TaskRouter {
  /** A session's turn ended; `message` is its last reply. Never throws. */
  turnEnded(sessionId: string, message: string): Promise<void>
  /** The user answered the session, or it was put away: a wait it set on its task is over. Never throws. */
  answered(sessionId: string): Promise<void>
}

export function createTaskRouter(deps: TaskRouterDeps): TaskRouter {
  const now = () => deps.now?.() ?? new Date()
  // What was last routed per session, so a turn that changed nothing writes nothing.
  const lastRouted = new Map<string, string>()
  // Waits held back per task while another session's wait is on it, oldest first.
  const memory = new Map<string, WaitingOn[]>()
  const heldWaits = deps.held ?? { get: (taskId: string) => memory.get(taskId) ?? [], set: (taskId: string, waits: WaitingOn[]) => { if (waits.length) memory.set(taskId, waits); else memory.delete(taskId) } }

  /** The session that set a wait still counts: not put away here, or not known here (another machine's). */
  const stillThere = (sessionId: string) => {
    const entry = deps.ledger.get(sessionId)
    return !entry || !entry.archivedAt
  }
  const hold = (taskId: string, wait: WaitingOn) =>
    heldWaits.set(taskId, [...heldWaits.get(taskId).filter((w) => w.session_id !== wait.session_id), wait])
  const drop = (taskId: string, sessionId: string) => {
    const waits = heldWaits.get(taskId)
    if (waits.some((w) => w.session_id === sessionId)) heldWaits.set(taskId, waits.filter((w) => w.session_id !== sessionId))
  }
  /** The held wait that takes a cleared wait's place, if one of a session still there is left. */
  const nextHeld = (taskId: string): WaitingOn | null => {
    const left = heldWaits.get(taskId).filter((w) => stillThere(w.session_id))
    const next = left.shift() ?? null
    heldWaits.set(taskId, left)
    return next
  }

  const route = async (sessionId: string, message: string) => {
    const entry = deps.ledger.get(sessionId)
    if (!entry?.taskId) return
    const space = deps.spaces.resolve(entry.spaceId)
    const brain = deps.brain(space)
    if (!brain) return

    const handoff = parseHandoff(message)
    let attention = entry.attention
    if (!handoff && !attention) return
    // The handoff, or without one the status: not the question the router itself put on the session.
    const key = handoff ? handoff.text : `${attention!.kind}:${attention!.reason ?? ''}`
    if (lastRouted.get(sessionId) === key) return

    const taskId = entry.taskId
    const task = await brain.get(`/engram/${taskId}`) as Task
    if (task.status !== 'planned' && task.status !== 'active') {
      lastRouted.set(sessionId, key)
      heldWaits.set(task.id, [])
      // A closed task waits on nobody.
      if (task.properties?.waiting_on) await brain.post(`/task/${task.id}/track`, { waiting_on: null }).catch(() => {})
      const asks = (handoff?.forUser.length ?? 0) > 0 || (attention !== null && needsAnswer(attention.kind))
      if (!asks) {
        deps.finished?.(sessionId)
        deps.log(`[router] ${sessionId.slice(0, 8)} task=${task.id.slice(0, 8)} closed, finished`)
      }
      return
    }
    // A status the session gave before the task was reopened belongs to the closed task: it must not
    // put a wait on the reopened one (seen on 4df3b729, where an old review wait came back).
    const reopened = reopenedAt(task)
    if (attention && reopened && attention.at < reopened) {
      attention = null
      if (!handoff) { lastRouted.set(sessionId, key); return }
    }
    const waiting = decideWaiting({ handoff, attention, checkpoint: task.properties?.checkpoint, owner: deps.owner, sessionId, now: now() })
    const current = task.properties?.waiting_on
    // Another session's wait stays until that session or the user moves on; this one's waits behind it.
    const othersWait = Boolean(current?.who && current.session_id && current.session_id !== sessionId && stillThere(current.session_id))
    const held = Boolean(waiting && othersWait)
    const clear = !waiting && current?.session_id === sessionId
    const patch: Record<string, unknown> = {}
    if (handoff) patch.text = handoff.text
    if (held) {
      hold(task.id, waiting!)
      if (!handoff) patch.text = `Another session's question is still open, so this one waits behind it: "${waiting!.why}"`
    } else if (waiting && (current?.why !== waiting.why || current?.session_id !== sessionId)) patch.waiting_on = waiting
    if (!held) drop(task.id, sessionId)
    if (clear) patch.waiting_on = nextHeld(task.id)
    lastRouted.set(sessionId, key)
    if (Object.keys(patch).length === 0) return
    await brain.post(`/task/${task.id}/track`, patch)
    const what = held ? `held behind ${current!.session_id!.slice(0, 8)}` : waiting ? `waiting on ${waiting.who}` : clear ? (patch.waiting_on ? 'cleared, next wait up' : 'cleared') : 'handoff'
    deps.log(`[router] ${sessionId.slice(0, 8)} task=${task.id.slice(0, 8)} ${what}`)
  }

  return {
    async answered(sessionId) {
      try {
        const entry = deps.ledger.get(sessionId)
        if (!entry?.taskId) return
        const space = deps.spaces.resolve(entry.spaceId)
        const brain = deps.brain(space)
        if (!brain) return
        drop(entry.taskId, sessionId)
        const task = await brain.get(`/engram/${entry.taskId}`) as Task
        if (task.properties?.waiting_on?.session_id !== sessionId) return
        const next = nextHeld(task.id)
        await brain.post(`/task/${task.id}/track`, { waiting_on: next })
        lastRouted.delete(sessionId)
        deps.log(`[router] ${sessionId.slice(0, 8)} answered: wait on task ${task.id.slice(0, 8)} cleared${next ? `, ${next.session_id.slice(0, 8)}'s wait up next` : ''}`)
      } catch (err) {
        deps.log(`[router] ${sessionId.slice(0, 8)} answered failed: ${(err as Error).message}`)
      }
    },

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
