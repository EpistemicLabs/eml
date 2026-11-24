import * as fs from 'node:fs'
import * as path from 'node:path'
import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace, BrainSpaces } from '../brain-space.js'
import { parseHandoff, type Handoff } from '../domain/handoff.js'
import { needsAnswer } from '../domain/session-attention.js'
import type { WaitKind } from '../domain/task-turn.js'
import { mostUrgent, sameWaits, waitsBody, waitsOf, withoutSession, withSessionWait, type Wait } from '../domain/task-waits.js'
import type { SessionLedger } from '../session-ledger.js'
import { COCKPIT_HOME } from '../paths.js'
import { trackWaits } from './task-waits.js'

/**
 * The router (decision one-router-for-steps-and-jobs): when a session's turn
 * ends, it decides whose turn it is and
 * writes that into the session's task.
 *
 *   - The session's handoff (domain/handoff.ts) goes into the task's history.
 *   - A question for the user, or a session that said question or failed
 *     (session_status), puts the task on the user: the session's wait
 *     { id, who, kind, why, since, session_id } in the task's waits — the Inbox
 *     lists it and opens the session. The session itself is not marked as
 *     waiting: it finished its turn, and the question is the task's (decision
 *     handoff-questions-inbox-only).
 *   - A step with checkpoint "after" that handed over a result, or any session
 *     that said review, waits for the user's review the same way.
 *   - A session has at most one wait per task (its id is the session's): its
 *     next wait replaces it, anything else removes it, and so does an answer or
 *     putting the session away. Other sessions' waits stay; a wait of a session
 *     put away on this machine is dropped with the next write.
 *   - Core keeps waiting_on as the most urgent wait (brain schema 23), so when
 *     one is answered the next one comes up by itself — also when it was
 *     answered on another member's machine.
 *   - A session that closed its task and asks nothing is finished: its
 *     handoff and outcome are in the task, so it leaves the lists (finished).
 *
 * The session never sets its waits itself (they are not among its tools); a
 * job's session is routed like any other, so a job needs no notify setting of
 * its own. A turn without a handoff and without a status changes nothing, and
 * the same handoff twice is written once.
 */

export interface TaskRouterDeps {
  ledger: Pick<SessionLedger, 'get'>
  spaces: Pick<BrainSpaces, 'resolve'>
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /** The handle of the person whose turn it becomes (config handle). */
  owner: string
  /** The session closed its task and nobody waits: its work is in the task's history (auto-archive). */
  finished?(sessionId: string): void
  log(line: string): void
  now?: () => Date
}

/** When the task was last reopened (board or chat), from its journal (the brain's /engram answer: a change entry "reopened (…)"); null when never. */
export function reopenedAt(task: { entries?: Array<{ kind?: string; at?: string; text?: string }> }): string | null {
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
  /**
   * Moves the waits a cockpit before brain schema 23 held back in held-waits.json
   * into their tasks' waits, then removes the file. Never throws.
   */
  adoptHeldWaits(file?: string): Promise<void>
}

export function createTaskRouter(deps: TaskRouterDeps): TaskRouter {
  const now = () => deps.now?.() ?? new Date()
  // What was last routed per session, so a turn that changed nothing writes nothing.
  const lastRouted = new Map<string, string>()
  // One write per task at a time on this host: the next one reads what the last one wrote.
  const queues = new Map<string, Promise<unknown>>()
  const serial = <T>(taskId: string, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(taskId) ?? Promise.resolve()).catch(() => {}).then(work)
    const tail = run.catch(() => {})
    queues.set(taskId, tail)
    void tail.then(() => { if (queues.get(taskId) === tail) queues.delete(taskId) })
    return run
  }

  /** The session of a wait still counts: not put away here, or not known here (another machine's). */
  const stillThere = (w: Wait) => {
    const sessionId = w.session_id ?? w.id
    const entry = deps.ledger.get(sessionId)
    return !entry || !entry.archivedAt
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

    let waiting: WaitingOn | null = null
    let closed = false
    let after: Wait[] = []
    const { task, patch } = await serial(entry.taskId, () => trackWaits(brain, entry.taskId!, (task) => {
      const waits = waitsOf(task.properties)
      closed = task.status !== 'planned' && task.status !== 'active'
      // A closed task waits on nobody.
      if (closed) return waits.length > 0 ? waitsBody([]) : null
      // A status the session gave before the task was reopened belongs to the closed task: it must not
      // put a wait on the reopened one (seen on 4df3b729, where an old review wait came back).
      const reopened = reopenedAt(task as { entries?: Array<{ kind?: string; at?: string; text?: string }> })
      if (attention && reopened && attention.at < reopened) {
        attention = null
        if (!handoff) return null
      }
      waiting = decideWaiting({ handoff, attention, checkpoint: task.properties?.checkpoint, owner: deps.owner, sessionId, now: now() })
      const kept = waits.filter((w) => (w.session_id ?? w.id) === sessionId || stillThere(w))
      after = waiting ? withSessionWait(kept, waiting) : withoutSession(kept, sessionId)
      const body: Record<string, unknown> = {}
      if (handoff) body.text = handoff.text
      if (!sameWaits(after, waits)) Object.assign(body, waitsBody(after))
      return Object.keys(body).length > 0 ? body : null
    }))
    lastRouted.set(sessionId, key)

    if (closed) {
      const asks = (handoff?.forUser.length ?? 0) > 0 || (attention !== null && needsAnswer(attention.kind))
      if (!asks) {
        deps.finished?.(sessionId)
        deps.log(`[router] ${sessionId.slice(0, 8)} task=${task.id.slice(0, 8)} closed, finished`)
      }
      return
    }
    if (!patch) return
    const w = waiting as WaitingOn | null
    const top = mostUrgent(after)
    const what = !('waits' in patch) ? 'handoff'
      : w ? (top?.id === sessionId ? `waiting on ${w.who}` : `waits behind ${(top?.session_id ?? top?.id ?? '?').slice(0, 8)}`)
      : top ? `cleared, ${(top.session_id ?? top.id).slice(0, 8)}'s wait up next` : 'cleared'
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
        let next: Wait | undefined
        const { task, patch } = await serial(entry.taskId, () => trackWaits(brain, entry.taskId!, (task) => {
          const waits = waitsOf(task.properties)
          const left = withoutSession(waits, sessionId)
          if (left.length === waits.length) return null
          next = mostUrgent(left)
          return waitsBody(left)
        }))
        lastRouted.delete(sessionId)
        if (!patch) return
        const up = next as Wait | undefined
        deps.log(`[router] ${sessionId.slice(0, 8)} answered: wait on task ${task.id.slice(0, 8)} cleared${up ? `, ${(up.session_id ?? up.id).slice(0, 8)}'s wait up next` : ''}`)
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

    async adoptHeldWaits(file = path.join(COCKPIT_HOME, 'held-waits.json')) {
      let held: Record<string, unknown>
      try {
        held = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          deps.log(`[router] held-waits.json unreadable, removed: ${(err as Error).message}`)
          fs.rmSync(file, { force: true })
        }
        return
      }
      let failed = false
      for (const [taskId, list] of Object.entries(held && typeof held === 'object' ? held : {})) {
        const sessions = Array.isArray(list) ? list.filter((w): w is WaitingOn => !!w && typeof w === 'object' && typeof (w as WaitingOn).session_id === 'string' && typeof (w as WaitingOn).who === 'string') : []
        const first = sessions.map((w) => deps.ledger.get(w.session_id)).find((e) => e?.taskId === taskId)
        const brain = first ? deps.brain(deps.spaces.resolve(first.spaceId)) : null
        if (!brain) continue
        try {
          await serial(taskId, () => trackWaits(brain, taskId, (task) => {
            if (task.status !== 'planned' && task.status !== 'active') return null
            const waits = waitsOf(task.properties)
            let after = waits
            for (const w of sessions) {
              if (stillThere({ ...w, id: w.session_id }) && !after.some((x) => (x.session_id ?? x.id) === w.session_id)) after = withSessionWait(after, w)
            }
            return sameWaits(after, waits) ? null : waitsBody(after)
          }))
        } catch (err) {
          failed = true
          deps.log(`[router] held waits of task ${taskId.slice(0, 8)} not adopted: ${(err as Error).message}`)
        }
      }
      if (!failed) {
        fs.rmSync(file, { force: true })
        deps.log('[router] held-waits.json adopted into the tasks\' waits and removed')
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
