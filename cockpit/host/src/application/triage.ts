import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EmlApiError, type EmlApi } from '@engramprotocol/mcp-server'
import { COCKPIT_HOME } from '../paths.js'

/**
 * Triage (decision cockpit-task-views-follow-linear-model): in a space with the
 * task system on, a standalone task a session creates on its own waits here,
 * in the cockpit, until Lasse accepts it (it becomes a brain task), merges it
 * into an open task, or closes it. The brain only ever sees approved tasks.
 *
 *   - eml_create_task from a session, without parent_id and without
 *     approved_by_user, and a worker's --new-task → a pending task
 *     (id pending-<uuid>); the session gets that id back with a note.
 *   - Progress on a pending task (eml_track_task) is kept and written into the
 *     task it becomes; a session's handoffs on it too (the router).
 *   - Any other use of a pending id (task_id, parent_id) is refused until it
 *     is resolved; after that the id stands for the real task.
 * Not triaged: the task the cockpit makes at a session's start, a step of an
 * approved task (parent_id), and a task the user asked for (approved_by_user).
 */

export const PENDING_PREFIX = 'pending-'
export const isPending = (id: unknown): id is string => typeof id === 'string' && id.startsWith(PENDING_PREFIX)

export interface PendingTask {
  id: string
  /** The space's id (BrainSpace.id). */
  spaceId: string
  /** What the session sent to eml_create_task, minus the triage flag. */
  fields: Record<string, unknown>
  title: string
  content: string
  scope: string
  source: { kind: 'session' | 'worker'; sessionId: string | null; sessionName: string | null }
  createdAt: string
  /** Progress and handoffs written before it was resolved. */
  entries: Array<{ at: string; text: string }>
  /** Whose turn it was, from a handoff before it was resolved. */
  waitingOn?: Record<string, string> | null
  /** The cockpit's guess where it belongs: an open task with the same words in the same project. */
  suggestion?: { kind: 'merge'; taskId: string; title: string } | null
  state: 'pending' | 'accepted' | 'merged' | 'closed'
  /** The brain task it became or went into. */
  taskId?: string
  resolvedAt?: string
}

const FILE = () => path.join(COCKPIT_HOME, 'triage.json')

export class TriageStore {
  private items: PendingTask[] = []
  private listeners = new Set<() => void>()

  constructor(private readonly file = FILE()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { items?: PendingTask[] }
      this.items = Array.isArray(parsed.items) ? parsed.items.filter((i) => isPending(i.id)) : []
    } catch { /* none yet */ }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    for (const listener of this.listeners) listener()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  add(item: Omit<PendingTask, 'id' | 'createdAt' | 'entries' | 'state'>): PendingTask {
    const pending: PendingTask = { ...item, id: `${PENDING_PREFIX}${randomUUID()}`, createdAt: new Date().toISOString(), entries: [], state: 'pending' }
    this.items.push(pending)
    this.persist()
    return pending
  }

  get(id: string): PendingTask | undefined {
    return this.items.find((i) => i.id === id)
  }

  /** What waits for triage, oldest first; resolved ones of the last day are kept for the ids sessions still hold. */
  pending(spaceId?: string): PendingTask[] {
    return this.items.filter((i) => i.state === 'pending' && (spaceId === undefined || i.spaceId === spaceId))
  }

  update(id: string, patch: Partial<PendingTask>): PendingTask | undefined {
    const item = this.get(id)
    if (!item) return undefined
    Object.assign(item, patch)
    // Resolved ones are kept a week: sessions may still use their ids.
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    this.items = this.items.filter((i) => i.state === 'pending' || !i.resolvedAt || Date.parse(i.resolvedAt) > cutoff)
    this.persist()
    return item
  }
}

/** A brain task as the triage reads it. */
interface Task { id: string; title: string | null; content: string; status: string; scope: string }

export interface TriageDeps {
  store: TriageStore
  /** The brain of a space as the cockpit writes to it (the space's agent). */
  brain(spaceId: string): Pick<EmlApi, 'get' | 'post'> | null
  /** The sessions working on a task id: they move to the task it becomes. */
  retarget(fromTaskId: string, toTaskId: string | null): void
  log(line: string): void
}

/** The view of a pending task an agent gets back from eml_create_task or eml_get. */
export function pendingView(item: PendingTask): Record<string, unknown> {
  const note = item.state === 'pending'
    ? 'This task waits for the user\'s triage in the cockpit; it is not in the brain yet. You may track progress on this id; do not link decisions, notes or sub-tasks to it until it is approved.'
    : item.state === 'closed' ? 'The user closed this task in triage.' : `Approved: the task is ${item.taskId}.`
  return { id: item.taskId ?? item.id, type: 'task', title: item.title, content: item.content, scope: item.scope, status: item.state === 'pending' ? 'pending triage' : item.state, triage: note }
}

export function createTriage(deps: TriageDeps) {
  /** An open task with the same words in the same project: the likely home of a new one. */
  const suggest = async (spaceId: string, scope: string, title: string): Promise<PendingTask['suggestion']> => {
    const brain = deps.brain(spaceId)
    if (!brain) return null
    const words = title.replace(/[-_]+/g, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 4).join(' ')
    if (!words) return null
    for (const status of ['active', 'planned']) {
      const found = await brain.get('/list', { type: 'task', scope, status, search: words, limit: 5 }).catch(() => null) as { engrams?: Task[] } | null
      const hit = found?.engrams?.[0]
      if (hit) return { kind: 'merge', taskId: hit.id, title: hit.title ?? hit.content.slice(0, 80) }
    }
    return null
  }

  const add = async (spaceId: string, fields: Record<string, unknown>, source: PendingTask['source']): Promise<PendingTask> => {
    const title = typeof fields.title === 'string' && fields.title ? fields.title : String(fields.content ?? 'task').slice(0, 60)
    const scope = typeof fields.scope === 'string' && fields.scope ? fields.scope : 'global'
    const item = deps.store.add({ spaceId, fields, title, content: String(fields.content ?? ''), scope, source, suggestion: null })
    deps.log(`[triage] ${item.id.slice(0, 16)} waits: ${title} (${source.kind}${source.sessionName ? ` · ${source.sessionName}` : ''})`)
    const suggestion = await suggest(spaceId, scope, title).catch(() => null)
    if (suggestion) deps.store.update(item.id, { suggestion })
    return deps.store.get(item.id)!
  }

  /** Write what was kept on the pending task into the brain task it became. */
  const flush = async (brain: Pick<EmlApi, 'post'>, item: PendingTask, taskId: string) => {
    for (const entry of item.entries) await brain.post(`/task/${taskId}/track`, { text: entry.text })
    if (item.waitingOn) await brain.post(`/task/${taskId}/track`, { waiting_on: item.waitingOn })
  }

  return {
    add,

    async accept(id: string, scope?: string): Promise<PendingTask> {
      const item = deps.store.get(id)
      if (!item || item.state !== 'pending') throw new Error('No such task in triage')
      const brain = deps.brain(item.spaceId)
      if (!brain) throw new Error('This space has no brain to write to')
      const created = await brain.post('/engram/task', { ...item.fields, ...(scope ? { scope } : {}) }) as Task
      await flush(brain, item, created.id)
      deps.retarget(item.id, created.id)
      deps.log(`[triage] ${id.slice(0, 16)} accepted as ${created.id.slice(0, 8)}`)
      return deps.store.update(id, { state: 'accepted', taskId: created.id, resolvedAt: new Date().toISOString() })!
    },

    async merge(id: string, taskId: string): Promise<PendingTask> {
      const item = deps.store.get(id)
      if (!item || item.state !== 'pending') throw new Error('No such task in triage')
      const brain = deps.brain(item.spaceId)
      if (!brain) throw new Error('This space has no brain to write to')
      const target = await brain.get(`/engram/${taskId}`) as Task
      if (target.status !== 'planned' && target.status !== 'active') throw new Error('Merge only into an open task')
      await brain.post(`/task/${taskId}/track`, { text: `Merged from triage: ${item.title}. ${item.content}`.trim() })
      await flush(brain, item, taskId)
      deps.retarget(item.id, taskId)
      deps.log(`[triage] ${id.slice(0, 16)} merged into ${taskId.slice(0, 8)}`)
      return deps.store.update(id, { state: 'merged', taskId, resolvedAt: new Date().toISOString() })!
    },

    close(id: string): PendingTask {
      const item = deps.store.get(id)
      if (!item || item.state !== 'pending') throw new Error('No such task in triage')
      deps.retarget(item.id, null)
      deps.log(`[triage] ${id.slice(0, 16)} closed`)
      return deps.store.update(id, { state: 'closed', resolvedAt: new Date().toISOString() })!
    },

    /** A handoff or progress on a pending task: kept for the task it becomes; a resolved one passes on. */
    keep(id: string, text: string | null, waitingOn?: Record<string, string> | null): string | null {
      const item = deps.store.get(id)
      if (!item) return null
      if (item.state !== 'pending') return item.taskId ?? null
      deps.store.update(id, {
        ...(text ? { entries: [...item.entries, { at: new Date().toISOString(), text }] } : {}),
        ...(waitingOn !== undefined ? { waitingOn } : {}),
      })
      return null
    },
  }
}

export type Triage = ReturnType<typeof createTriage>

/** The ids in a write that name a task. */
const TASK_REFS = ['task_id', 'parent_id'] as const

/**
 * A session's brain client with triage in front (brain-mcp.ts): new standalone
 * tasks wait in the cockpit; pending ids resolve to their task once approved.
 */
export function triagedClient(inner: EmlApi, deps: { triage: Triage; store: TriageStore; spaceId: string; sessionId: string; sessionName: () => string | null }): EmlApi {
  const resolve = (id: string): string => {
    const item = deps.store.get(id)
    if (!item) throw new EmlApiError(404, { error: `No task ${id}` }, `No task ${id}`)
    if (item.state === 'pending') throw new EmlApiError(409, { error: `Task ${id} waits for the user's triage; link it once it is approved.` }, 'pending triage')
    if (!item.taskId) throw new EmlApiError(410, { error: `Task ${id} was closed in triage.` }, 'closed in triage')
    return item.taskId
  }
  const rewrite = (body: unknown): unknown => {
    if (!body || typeof body !== 'object') return body
    const copy = { ...(body as Record<string, unknown>) }
    for (const key of TASK_REFS) if (isPending(copy[key])) copy[key] = resolve(copy[key] as string)
    return copy
  }
  return {
    async get(p, query) {
      const m = /^\/engram\/(pending-[^/]+)$/.exec(p)
      if (m) {
        const item = deps.store.get(m[1])
        if (!item) throw new EmlApiError(404, { error: 'engram not found' }, 'engram not found')
        return item.taskId ? inner.get(`/engram/${item.taskId}`, query) : pendingView(item)
      }
      return inner.get(p, query)
    },
    async post(p, body) {
      const fields = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
      if (p === '/engram/task') {
        const approved = fields.approved_by_user === true
        const { approved_by_user: _flag, ...rest } = fields
        // A step of a real task, or a task the user asked for, goes straight in.
        if (approved || (typeof rest.parent_id === 'string' && rest.parent_id && !isPending(rest.parent_id))) return inner.post(p, rewrite(rest))
        if (isPending(rest.parent_id)) resolve(rest.parent_id as string)
        const item = await deps.triage.add(deps.spaceId, rest, { kind: 'session', sessionId: deps.sessionId, sessionName: deps.sessionName() })
        return pendingView(item)
      }
      const track = /^\/task\/(pending-[^/]+)\/track$/.exec(p)
      if (track) {
        const item = deps.store.get(track[1])
        if (!item) throw new EmlApiError(404, { error: 'task not found' }, 'task not found')
        if (item.state === 'pending') {
          const text = [fields.text, fields.outcome].filter((v) => typeof v === 'string' && v).join(' · ')
          if (text) deps.triage.keep(item.id, text)
          return pendingView(deps.store.get(item.id)!)
        }
        return inner.post(`/task/${resolve(item.id)}/track`, rewrite(body))
      }
      return inner.post(p, rewrite(body))
    },
    put: (p, body) => inner.put(p, rewrite(body)),
  }
}
