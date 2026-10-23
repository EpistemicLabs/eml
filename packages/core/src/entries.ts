import type Database from 'better-sqlite3'
import type { Stamp } from './env'

// --- Entries (v0.19, was task_entries) -------------------------------------------
//
// An engram's append-only entries, stamped with time, author, session and model:
//   note     — a task journal entry the agent wrote (progress, the closing story)
//   change   — a one-liner the server writes for every change to a task
//   evidence — an incident behind a learning (source, stance, quote)
//   review   — a confirmation that a decision, rule or profile still holds
// Entries are never edited or deleted (only with their engram).

export const ENTRY_KINDS = ['note', 'change', 'evidence', 'review'] as const
export type EntryKind = typeof ENTRY_KINDS[number]

export const EVIDENCE_SOURCES = ['user', 'observed', 'self'] as const
export type EvidenceSource = typeof EVIDENCE_SOURCES[number]
export const EVIDENCE_STANCES = ['supports', 'contradicts', 'declined'] as const
export type EvidenceStance = typeof EVIDENCE_STANCES[number]

export interface Entry {
  id: string
  engram_id: string
  kind: EntryKind
  at: string
  author: string | null
  session_id: string | null
  model: string | null
  stage: string | null
  text: string
  source: EvidenceSource | null
  stance: EvidenceStance | null
  quote: string | null
  rule_id: string | null
}

export interface EntryInput {
  kind: EntryKind
  text: string
  stage?: string | null
  source?: EvidenceSource
  stance?: EvidenceStance
  quote?: string
  rule_id?: string
}

/**
 * v0.20: the write changed engram `id` — its rev goes up by one, once per write
 * (decision engram-revision-counter). An engram the write created stays at 1.
 */
export function bumpRev(db: Database.Database, w: Stamp, id: string): void {
  if (w.created.has(id) || w.touched.has(id)) return
  w.touched.add(id)
  db.prepare('UPDATE engrams SET rev = rev + 1 WHERE id = ?').run(id)
}

/** Append one entry, at the write's time and by its actor; an entry is a change of its engram (rev). Runs inside the caller's transaction when there is one. */
export function appendEntry(db: Database.Database, engramId: string, input: EntryInput, w: Stamp): Entry {
  const entry: Entry = {
    id: w.newId(),
    engram_id: engramId,
    kind: input.kind,
    at: w.at,
    author: w.actor.handle,
    session_id: w.actor.session_id,
    model: w.actor.model,
    stage: input.stage ?? null,
    text: input.text,
    source: input.source ?? null,
    stance: input.stance ?? null,
    quote: input.quote ?? null,
    rule_id: input.rule_id ?? null,
  }
  db.prepare(`
    INSERT INTO entries (id, engram_id, kind, at, author, session_id, model, stage, text, source, stance, quote, rule_id)
    VALUES (@id, @engram_id, @kind, @at, @author, @session_id, @model, @stage, @text, @source, @stance, @quote, @rule_id)
  `).run(entry)
  bumpRev(db, w, engramId)
  return entry
}

/** An engram's entries, oldest first; optionally only some kinds. */
export function listEntries(db: Database.Database, engramId: string, kinds?: readonly EntryKind[]): Entry[] {
  const filter = kinds && kinds.length > 0 ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : ''
  return db.prepare(
    `SELECT id, engram_id, kind, at, author, session_id, model, stage, text, source, stance, quote, rule_id
     FROM entries WHERE engram_id = ?${filter} ORDER BY at ASC, rowid ASC`,
  ).all(engramId, ...(kinds ?? [])) as Entry[]
}
