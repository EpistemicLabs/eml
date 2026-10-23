import type * as http from 'node:http'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { brainIdFromProjectId, projectIdForBrain } from './project-registry.js'

/**
 * Notes (decision cockpit-notes-pane): a note is a `type=note` engram in the
 * scope of a brain project, edited in a note pane and listed in the sidebar.
 * The pane reaches the brain only through these routes — they are the
 * capabilities a notes plugin would later declare (notes.list / read / write
 * / subscribe), so extracting it is a move, not a rewrite.
 *
 *   GET    /api/notes?projectId=   the project's active notes, newest first
 *   POST   /api/notes              { projectId, content? } → new note
 *   GET    /api/notes/<id>         one note
 *   PUT    /api/notes/<id>         { content, baseRev } → 409 + the current
 *                                  note when it changed since baseRev
 *   DELETE /api/notes/<id>         archive (status invalidated), no hard delete
 * plus the `notes` event on /api/events (NotesWatcher).
 *
 * Pane notes carry origin `cockpit-notes` (v0.19; was properties.source_id).
 * Who wrote the current content: every write from here stamps
 * properties.app.user_content_hash. An agent edit (eml_update) replaces the
 * content but leaves the stamp, so a mismatch means the agent wrote last. The
 * UserPromptSubmit hook reads the same stamp to show only the user's edits.
 */

export interface NotesDeps {
  loopbackUrl: string
  brainToken: string
}

export interface NoteView {
  id: string
  projectId: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  /** The engram's revision counter (v0.20): any write moves it on; a save sends the rev it is based on. */
  rev: number
  lastEditor: 'user' | 'agent'
}

type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>

interface Engram {
  id: string
  type: string
  scope: string
  status: string
  content: string
  created_at: string
  updated_at: string
  rev: number
  origin?: string | null
  properties?: { app?: { user_content_hash?: string } } & Record<string, unknown>
}

const MAX_CONTENT = 200_000
const NEW_NOTE_CONTENT = 'New note'
export const NOTES_ORIGIN = 'cockpit-notes'

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** First non-empty line, without markdown heading/list/checkbox markers. */
export function noteTitle(content: string): string {
  const line = content.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const bare = line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '').trim()
  return (bare || 'Untitled').slice(0, 120)
}

function scopeForProject(projectId: string): string | null {
  const brainId = brainIdFromProjectId(projectId)
  return brainId ? `project.${brainId}` : null
}

function projectForScope(scope: string): string | null {
  return scope.startsWith('project.') ? projectIdForBrain(scope.slice('project.'.length)) : null
}

function toView(e: Engram): NoteView | null {
  const projectId = projectForScope(e.scope)
  if (e.type !== 'note' || !projectId) return null
  return {
    id: e.id,
    projectId,
    title: noteTitle(e.content),
    content: e.content,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    rev: e.rev,
    lastEditor: e.properties?.app?.user_content_hash === contentHash(e.content) ? 'user' : 'agent',
  }
}

async function brain<T>(deps: NotesDeps, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${deps.loopbackUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${deps.brainToken}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { data = { error: text } }
  return { status: res.status, data: data as T }
}

// Only a pane note (origin cockpit-notes, like listNotes): an agent's note is
// not found here, so the pane cannot read, overwrite or archive it.
async function getNote(deps: NotesDeps, id: string): Promise<Engram | null> {
  const { status, data } = await brain<Engram>(deps, `/engram/${encodeURIComponent(id)}`)
  if (status !== 200 || !data || data.type !== 'note' || data.status !== 'active' || data.origin !== NOTES_ORIGIN) return null
  return projectForScope(data.scope) ? data : null
}

export async function listNotes(deps: NotesDeps, scope?: string): Promise<NoteView[]> {
  // Only notes written in the pane: agents write notes too (task plans, re-filed
  // decisions), and those belong to the brain, not to the user's notes list.
  const q = new URLSearchParams({ type: 'note', status: 'active', origin: NOTES_ORIGIN, order_by: 'updated_at', limit: '200' })
  if (scope) q.set('scope', scope)
  const { status, data } = await brain<{ engrams?: Engram[] }>(deps, `/list?${q}`)
  if (status !== 200) throw new Error(`brain /list → ${status}`)
  return (data.engrams ?? [])
    .map(toView)
    .filter((n): n is NoteView => n !== null)
}

export async function handleNotesApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: NotesDeps,
  url: URL,
  method: string,
  json: Json,
  readJson: ReadJson,
  watcher: NotesWatcher,
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean) // ['api', 'notes', id?]
  if (parts[1] !== 'notes' || parts.length > 3) return false
  const id = parts[2]
  const notFound = () => json(res, 404, { error: { code: 'NOT_FOUND', message: 'Note not found' } })
  const needsBrain = () => json(res, 400, {
    error: { code: 'NEEDS_BRAIN_PROJECT', message: 'Notes live in the brain — this project exists only as a folder' },
  })

  if (!id && method === 'GET') {
    const scope = scopeForProject(url.searchParams.get('projectId') ?? '')
    if (!scope) { needsBrain(); return true }
    json(res, 200, { notes: await listNotes(deps, scope) })
    return true
  }

  if (!id && method === 'POST') {
    const body = await readJson(req)
    const scope = scopeForProject(typeof body.projectId === 'string' ? body.projectId : '')
    if (!scope) { needsBrain(); return true }
    const content = typeof body.content === 'string' && body.content.trim() ? body.content : NEW_NOTE_CONTENT
    if (content.length > MAX_CONTENT) { json(res, 413, { error: { code: 'TOO_LARGE', message: 'Note too large' } }); return true }
    const { status, data } = await brain<Engram>(deps, '/engram/note', {
      scope, content, origin: NOTES_ORIGIN, app: { user_content_hash: contentHash(content) },
    })
    if (status !== 201) { json(res, 502, { error: { code: 'BRAIN_WRITE_FAILED', message: JSON.stringify(data) } }); return true }
    watcher.poke()
    json(res, 201, { note: toView(data) })
    return true
  }

  if (!id) return false
  const current = await getNote(deps, id)
  if (!current) { notFound(); return true }

  if (method === 'GET') {
    json(res, 200, { note: toView(current) })
    return true
  }

  if (method === 'PUT') {
    const body = await readJson(req)
    if (typeof body.content !== 'string') { json(res, 400, { error: { code: 'INVALID_INPUT', message: 'content required' } }); return true }
    if (body.content.length > MAX_CONTENT) { json(res, 413, { error: { code: 'TOO_LARGE', message: 'Note too large' } }); return true }
    // The brain checks base_rev in the write itself (v0.20: compare-and-swap on
    // the engram's rev). No baseRev = overwrite on purpose ("keep mine" after a conflict).
    const baseRev = typeof body.baseRev === 'number' ? body.baseRev : undefined
    const content = body.content.trim() ? body.content : NEW_NOTE_CONTENT
    const { status, data } = await brain<Engram>(deps, '/update', {
      id, patch: { content, app: { user_content_hash: contentHash(content) } },
      ...(baseRev !== undefined ? { base_rev: baseRev } : {}),
    })
    if (status === 409) {
      const now = await getNote(deps, id)
      if (!now) { notFound(); return true }
      json(res, 409, { error: { code: 'CONFLICT', message: 'The note changed since you opened it' }, note: toView(now) })
      return true
    }
    if (status !== 200) { json(res, 502, { error: { code: 'BRAIN_WRITE_FAILED', message: JSON.stringify(data) } }); return true }
    watcher.poke()
    json(res, 200, { note: toView(data) })
    return true
  }

  if (method === 'DELETE') {
    const { status, data } = await brain<Engram>(deps, '/update', { id, patch: { status: 'invalidated' } })
    if (status !== 200) { json(res, 502, { error: { code: 'BRAIN_WRITE_FAILED', message: JSON.stringify(data) } }); return true }
    watcher.poke()
    json(res, 200, { success: true })
    return true
  }
  return false
}

export interface NotesChange {
  /** Notes whose content changed, appeared or were archived since the last poll. */
  changed: Array<{ id: string; projectId: string; rev: number | null; lastEditor: 'user' | 'agent' | null }>
}

/**
 * Agent edits go to the brain over MCP and never pass the host, so the host
 * polls the brain (loopback, one indexed query) while at least one page
 * listens, and emits `notes` with what changed. UI writes call poke() to
 * report at once instead of on the next tick.
 */
export class NotesWatcher extends EventEmitter {
  private known: Map<string, { rev: number; projectId: string }> | null = null
  private timer: NodeJS.Timeout | null = null
  private listeners_ = 0
  private polling = false

  constructor(private deps: NotesDeps, private intervalMs = 3_000) {
    super()
  }

  subscribe(onChange: (change: NotesChange) => void): () => void {
    this.on('notes', onChange)
    this.listeners_ += 1
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), this.intervalMs)
      void this.poll()
    }
    return () => {
      this.off('notes', onChange)
      this.listeners_ -= 1
      if (this.listeners_ <= 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = null
        this.known = null
        this.listeners_ = 0
      }
    }
  }

  poke(): void {
    if (this.timer) void this.poll()
  }

  private async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const notes = await listNotes(this.deps)
      const next = new Map(notes.map((n) => [n.id, { rev: n.rev, projectId: n.projectId }]))
      if (this.known) {
        const changed: NotesChange['changed'] = []
        for (const n of notes) {
          if (this.known.get(n.id)?.rev !== n.rev) {
            changed.push({ id: n.id, projectId: n.projectId, rev: n.rev, lastEditor: n.lastEditor })
          }
        }
        for (const [id, prev] of this.known) {
          if (!next.has(id)) changed.push({ id, projectId: prev.projectId, rev: null, lastEditor: null })
        }
        if (changed.length) this.emit('notes', { changed } satisfies NotesChange)
      }
      this.known = next
    } catch {
      // Brain briefly unreachable — keep the last known state, try next tick.
    } finally {
      this.polling = false
    }
  }
}
