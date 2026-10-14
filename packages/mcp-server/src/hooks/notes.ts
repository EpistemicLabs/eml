import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import type { EmlConfig } from '../config'

/**
 * Note edits for the UserPromptSubmit hook (decision cockpit-notes-pane): the
 * user edits `type=note` engrams in a note pane; before each prompt the agent
 * sees what changed in the notes of its project since its last prompt.
 *
 * Only the user's edits are shown. A note pane stamps
 * properties.user_content_hash on every save; an agent edit (eml_update)
 * replaces the content but not the stamp, so a mismatch means the agent wrote
 * last — its own edit, which it already knows. Those only move the snapshot.
 *
 * Scope: EML_PROJECT_SCOPE (the cockpit sets it per session), else
 * project.<basename(cwd)> like the reminder's nudge. State: one snapshot file
 * per session in <stateDir>/notes. Every failure is silent — a hook never
 * blocks a prompt.
 */

const NOTES_TIMEOUT_MS = 3000
const MAX_OUTPUT = 2500
const MAX_NEW_NOTE_LINES = 15
const SAFE_SESSION_ID = /^[A-Za-z0-9_.-]+$/
const SAFE_SCOPE = /^project\.[A-Za-z0-9_.-]+$/
/** Notes written in the cockpit notes pane carry this source_id (cockpit notes-api). */
const PANE_SOURCE_ID = 'cockpit-notes'

interface NoteEngram {
  id: string
  content: string
  properties?: Record<string, unknown>
}

type Snapshot = Record<string, { title: string; content: string }>

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** Same rule as the cockpit's sidebar: first non-empty line, markers stripped. */
export function noteTitle(content: string): string {
  const line = content.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const bare = line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '').trim()
  return (bare || 'Untitled').slice(0, 80)
}

export function notesScope(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.EML_PROJECT_SCOPE ?? ''
  if (SAFE_SCOPE.test(fromEnv)) return fromEnv
  const base = cwd ? path.basename(cwd) : ''
  const scope = `project.${base}`
  return base && SAFE_SCOPE.test(scope) ? scope : null
}

const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/

/**
 * Line diff for notes: checkbox toggles read as "☑ X (was ☐)", other lines
 * as +/−. Order follows the new content; moved lines are not reported.
 */
export function diffNote(before: string, after: string): string[] {
  const oldLines = before.split('\n').filter((l) => l.trim())
  const newLines = after.split('\n').filter((l) => l.trim())
  const remaining = new Map<string, number>()
  for (const l of oldLines) remaining.set(l, (remaining.get(l) ?? 0) + 1)
  const added: string[] = []
  for (const l of newLines) {
    const n = remaining.get(l) ?? 0
    if (n > 0) remaining.set(l, n - 1)
    else added.push(l)
  }
  const removed = oldLines.filter((l) => {
    const n = remaining.get(l) ?? 0
    if (n <= 0) return false
    remaining.set(l, n - 1)
    return true
  })

  const out: string[] = []
  for (const l of added) {
    const m = TASK.exec(l)
    const toggled = m && removed.findIndex((r) => {
      const o = TASK.exec(r)
      return o !== null && o[3].trim() === m[3].trim() && (o[2] === ' ') !== (m[2] === ' ')
    })
    if (m && typeof toggled === 'number' && toggled >= 0) {
      removed.splice(toggled, 1)
      const done = m[2] !== ' '
      out.push(`  ${done ? '☑' : '☐'} ${m[3].trim()}   (was ${done ? '☐' : '☑'})`)
    } else {
      out.push(`  + ${l.trim()}`)
    }
  }
  for (const l of removed) out.push(`  − ${l.trim()}`)
  return out
}

function readSnapshot(file: string): Snapshot | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed as Snapshot : null
  } catch {
    return null
  }
}

export interface NotesResult {
  output: string
  log: string
}

export async function notesUpdate(
  cfg: EmlConfig | null,
  stateDir: string,
  input: { session_id?: string; cwd?: string },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<NotesResult> {
  const sessionId = input.session_id ?? ''
  const scope = notesScope(input.cwd || process.cwd(), env)
  if (!cfg?.EML_URL || !cfg.EML_API_TOKEN || !SAFE_SESSION_ID.test(sessionId) || !scope) {
    return { output: '', log: 'notes: skipped (no config, session or scope)' }
  }

  let notes: NoteEngram[]
  try {
    const q = new URLSearchParams({ type: 'note', scope, status: 'active', order_by: 'updated_at', limit: '50' })
    const res = await fetchImpl(`${cfg.EML_URL}/list?${q}`, {
      headers: { Authorization: `Bearer ${cfg.EML_API_TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(NOTES_TIMEOUT_MS),
    })
    // An older brain without the note type answers 400 — nothing to show.
    if (!res.ok) return { output: '', log: `notes: list → ${res.status}` }
    // Only the user's notes from the cockpit notes pane — agent-written notes
    // (task plans, re-filed decisions) are not the user's.
    notes = (((await res.json()) as { engrams?: NoteEngram[] }).engrams ?? [])
      .filter((n) => n.properties?.source_id === PANE_SOURCE_ID)
  } catch (err) {
    return { output: '', log: `notes: unreachable ${(err as Error).message}` }
  }

  const dir = path.join(stateDir, 'notes')
  const file = path.join(dir, `${sessionId}.json`)
  const before = readSnapshot(file)
  const next: Snapshot = {}
  for (const n of notes) next[n.id] = { title: noteTitle(n.content), content: n.content }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify(next))
  } catch { /* a lost snapshot only repeats a diff */ }

  // First prompt of the session: name the notes, no diff.
  if (!before) {
    if (!notes.length) return { output: '', log: `notes: first turn, none in ${scope}` }
    const list = notes.map((n) => `- "${noteTitle(n.content)}" (${n.id})`).join('\n')
    return {
      output: `[Notes in ${scope}] — the user's notes for this project (eml_get <id> to read):\n${list}`,
      log: `notes: first turn, ${notes.length} in ${scope}`,
    }
  }

  const sections: string[] = []
  for (const n of notes) {
    const prev = before[n.id]
    if (prev?.content === n.content) continue
    if (n.properties?.user_content_hash !== contentHash(n.content)) continue // the agent wrote last
    const title = noteTitle(n.content)
    if (!prev) {
      const lines = n.content.split('\n').filter((l) => l.trim())
      const shown = lines.slice(0, MAX_NEW_NOTE_LINES).map((l) => `  ${l.trim()}`)
      if (lines.length > shown.length) shown.push(`  … ${lines.length - shown.length} more lines`)
      sections.push(`New note "${title}" (${n.id}):\n${shown.join('\n')}`)
      continue
    }
    const diff = diffNote(prev.content, n.content)
    if (diff.length) sections.push(`"${title}" (${n.id}):\n${diff.join('\n')}`)
  }
  for (const [id, prev] of Object.entries(before)) {
    if (!next[id]) sections.push(`"${prev.title}" (${id}) was archived or removed.`)
  }
  if (!sections.length) return { output: '', log: `notes: no user edits in ${scope}` }

  let output = `[Notes changed by the user since your last turn — ${scope}]\n${sections.join('\n\n')}`
  if (output.length > MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}\n… (truncated — eml_get <id> for the full note)`
  return { output, log: `notes: ${sections.length} change(s) in ${scope}` }
}
