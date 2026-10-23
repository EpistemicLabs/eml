import Database from 'better-sqlite3'
import {
  Engram, EngramInput, EngramQuery, EngramWithRelations,
  Relation, RelationWithTarget, RelationInput, ScopedBrainState,
  TYPE_DEFAULT_STATUS, TYPE_REVIEW_DEFAULTS,
  EngramType, ConflictCandidate, StoredEngram, DetectionMethod,
  EngramStatus, OpenSubtask, BoundItem,
  TASK_OPEN_STATUSES, TASK_LINK_RELATION,
} from './types'
import { significanceWeight, recencyBoost } from './decay'
import { validateEngramType, validateFormat, validateScopePattern, validateScopeExists, validateNoTemplateLeak } from './validate'
import { TYPE_FIELDS, ORIGINS, SEED_ORIGIN, validateFields, fieldProblem, unknownFieldsError, isBlank } from './fields'
import {
  appendEntry, listEntries, EVIDENCE_SOURCES, EVIDENCE_STANCES,
  type Entry, type EntryInput, type EntryKind, type EvidenceSource, type EvidenceStance,
} from './entries'
import { learningState, LEARNING_SHARPENED, type LearningState } from './learning'
import { ProjectStore } from './projects'
import { UserStore } from './users'
import { AgentStore } from './agents'
import { EntityStore } from './entities'
import { TagStore, slugifyTag, hydrateEngramTags } from './tags'
import { type Env, type Stamp, beginWrite, addDays, DEFAULT_ENV } from './env'
import { REVIEWABLE_TYPES, reviewDueSql, reviewDueParams, hydrateReviewDue } from './review-due'
import { SubjectStore, slugifySubject, hydrateEngramSubjects } from './subjects'
import { OPEN_TASKS_IN_SCOPE_SQL, OPEN_TASKS_COUNT_SQL, BACKLOG_COUNT_SQL } from './open-tasks'

// v0.9 Cluster 1: namespace concept removed entirely (Phase 1.3 code, Phase 1.4 DB).

/** v0.19.1: the change entry on a bound item that closed with its task (followed by the task id). */
export const CLOSED_WITH_TASK = 'closed with task'

/**
 * v0.14 Cluster C: parse `[[target]]` wikilinks out of engram content into a
 * clean, de-duplicated, order-preserving list of targets. Tolerant: an Obsidian
 * `[[target|display]]` keeps only the target; whitespace is trimmed; empty and
 * newline-spanning matches are dropped. Pure + exported so the parse is unit-
 * testable independent of resolution. `target` is later resolved to an engram id
 * (title-slug or id-prefix) by the write path — see materializeWikilinks.
 */
export function extractWikilinkTargets(content: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /\[\[([^\][\n]+?)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const target = m[1].split('|')[0].trim()
    if (!target || seen.has(target)) continue
    seen.add(target)
    out.push(target)
  }
  return out
}

/**
 * v0.10.5: relative bm25 gap (measured against a bucket's best row) that still
 * counts as "comparably relevant" for the recall tiebreak. Tunable; see decision
 * read-layer-and-boot-architecture.
 */
export const BM25_RELEVANCE_EPS = 0.15

/**
 * v0.10.5 bucket-tiebreak. `ranked` is bm25-ordered (best match first). Rows
 * within `eps` relative gap of a bucket's best row form one "comparable
 * relevance" bucket; within a bucket, `scoreFn` (significance × recency) decides.
 * Buckets stay in bm25 order. Counteracts bm25 length-normalisation burying long,
 * important engrams under short term-dense ones, without a hand-tuned blend.
 * Pure + exported so the EPS gate is unit-testable independent of FTS internals.
 */
export function bucketByRelevance<E>(
  ranked: { engram: E; rank: number }[],
  scoreFn: (e: E) => number,
  eps: number,
): E[] {
  const buckets: { engram: E; rank: number }[][] = []
  for (const item of ranked) {
    const cur = buckets[buckets.length - 1]
    const anchor = cur ? cur[0].rank : null
    const gap = anchor !== null ? Math.abs(item.rank - anchor) / Math.abs(anchor) : Infinity
    if (gap < eps) cur.push(item)
    else buckets.push([item])
  }
  return buckets.flatMap(bucket =>
    [...bucket].sort((a, b) => scoreFn(b.engram) - scoreFn(a.engram)).map(x => x.engram),
  )
}

// ============================================================
// v0.10.9: write-time conflict guardrail (`potential_conflicts`)
// ----
// On a knowledge-bearing write we surface the active same-scope engrams the write
// may duplicate/contradict, and let the writing agent (already an LLM) resolve them.
// The server does the cheap deterministic half: FTS-retrieve scoped active candidates,
// then gate on TERM-COVERAGE (not BM25 magnitude — BM25 only ranks). Coverage is the
// fraction of the new write's salient terms present in the candidate: inherently 0–1,
// so the threshold is corpus-independent and stable as a brain grows. See
// docs/specs/v0.10.9-PROPOSAL.md + decision v0.10.9-conflict-guardrail-scope.
// ============================================================

/**
 * Written types that get a conflict scan. A log is the session's own narrative;
 * an event is only compared with events (v0.19: the same change_type, close in
 * time — the duplicate protection of eml_event). Learnings have their own
 * topic check (learn()), not this scan.
 */
export const CONFLICT_TYPES: ReadonlySet<EngramType> = new Set<EngramType>([
  'decision', 'status', 'rule', 'reference', 'note', 'task', 'event', 'profile',
])
/** v0.19: two events of the same change_type this close together may be one. */
export const EVENT_DUPLICATE_WINDOW_MS = 36 * 3600_000
/** Coverage gate, calibrated ≈0.5 (live-brain eval-set 2026-06-05; revisit task 1ce18eb9). */
export const CONFLICT_COVERAGE_THRESHOLD = 0.5
/** Over-fetch generously, THEN filter, THEN cap — never SQL limit:N then post-filter (the C0 bug class). */
export const CONFLICT_CANDIDATE_LIMIT = 25
/**
 * v0.19: a candidate also shares at least this many salient terms with the
 * write. Coverage alone is a share: a write of three or four words reached
 * 50–75 % against any long note that happened to use two of them.
 */
export const CONFLICT_MIN_SHARED_TERMS = 3
/** Backstop cap on survivors. The real precision lever is the coverage gate. */
export const CONFLICT_MAX = 3

// Stopwords len≥4 (shorter ones are dropped by the len≥4 cut anyway). Keeps content
// salient-term extraction honest without favouring filler that overlaps everywhere.
const CONFLICT_STOPWORDS: ReadonlySet<string> = new Set([
  'this', 'that', 'these', 'those', 'with', 'from', 'have', 'has', 'had', 'been',
  'were', 'they', 'them', 'their', 'there', 'what', 'when', 'which', 'while', 'would',
  'could', 'should', 'about', 'into', 'than', 'then', 'also', 'such', 'only', 'some',
  'more', 'most', 'other', 'over', 'after', 'before', 'because', 'will', 'shall',
  'does', 'done', 'each', 'both', 'here', 'very', 'just', 'like', 'much', 'many',
])

function conflictTokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/**
 * v1 salient-term extraction (pure, exported for unit-testing the coverage gate
 * independent of FTS internals). Title tokens (the recall anchor, kebab-split,
 * unfiltered) + content terms that are stopword-stripped and len≥4. Deduped.
 * The acceptance gate confirmed this naive cut is sufficient at threshold 0.5.
 */
export function extractSalientTerms(title: string | null, content: string): string[] {
  const terms = new Set<string>()
  for (const t of conflictTokenize(title ?? '')) terms.add(t)
  for (const t of conflictTokenize(content)) {
    if (t.length >= 4 && !CONFLICT_STOPWORDS.has(t)) terms.add(t)
  }
  return [...terms]
}

/**
 * Term-coverage (pure, exported): fraction of the new write's salient terms that
 * appear anywhere in the candidate's text. 0–1, corpus-independent. Empty salient
 * set → 0 (cannot judge overlap → never fires).
 */
export function termCoverage(salient: string[], candidateText: string): number {
  if (salient.length === 0) return 0
  const candTokens = new Set(conflictTokenize(candidateText))
  let hit = 0
  for (const t of salient) if (candTokens.has(t)) hit++
  return hit / salient.length
}

// --- v0.19 write inputs -------------------------------------------------------------

/** What store() takes besides the type's fields (EngramInput). */
export const STORE_INPUT_KEYS: ReadonlySet<string> = new Set([
  'type', 'content', 'scope', 'title', 'status', 'properties', 'tags', 'subjects',
  'parent_id', 'task_id', 'supersedes', 'from_learning', 'origin', 'app',
])

/** eml_update's patch: the universal fields; the type's fields go in properties. */
export interface EngramPatch {
  content?: string
  title?: string | null
  scope?: string
  status?: EngramStatus
  properties?: Record<string, unknown>
  tags?: string[]
  subjects?: string[]
  supersedes?: string[]
  review_note?: string
  /** The software's own state, replaced as a whole; only on an engram with an origin. */
  app?: Record<string, string>
}
export const UPDATE_PATCH_KEYS: ReadonlySet<string> = new Set([
  'content', 'title', 'scope', 'status', 'properties', 'tags', 'subjects', 'supersedes', 'review_note', 'app',
])

/** eml_track_task: everything that happens to an existing task. */
export interface TrackTaskInput {
  text?: string
  status?: EngramStatus
  outcome?: string
  keep?: string[]
  stage?: string | null
  content?: string
  title?: string
  context?: string | null
  priority?: string | null
  assignee_id?: string | null
  due_date?: string | null
  blockers?: string[] | null
  parent_id?: string | null
  scope?: string
  /** Tasks this one replaces after the fact (task → task; their bound items move here). */
  supersedes?: string[]
  tags?: string[]
  subjects?: string[]
}
export const TRACK_TASK_KEYS: ReadonlySet<string> = new Set([
  'text', 'status', 'outcome', 'keep', 'stage', 'content', 'title', 'context', 'priority',
  'assignee_id', 'due_date', 'blockers', 'parent_id', 'scope', 'supersedes', 'tags', 'subjects',
])

/** eml_learning: a new lesson, or an incident added to one (id). */
export interface LearnInput {
  id?: string
  content?: string
  scope?: string
  title?: string
  source: string
  happened: string
  quote?: string
  stance?: string
  new_topic?: boolean
  rule_id?: string
  tags?: string[]
  subjects?: string[]
}
export const LEARN_KEYS: ReadonlySet<string> = new Set([
  'id', 'content', 'scope', 'title', 'source', 'happened', 'quote', 'stance', 'new_topic',
  'rule_id', 'tags', 'subjects',
])

export type LearnResult =
  | { written: true, engram: Engram, learning: LearningState }
  | { written: false, matches: Array<{ id: string, scope: string, title: string | null, content: string, coverage: number }> }

/** A learning says what to do, like a rule. */
export const LEARNING_CONTENT_MAX_CHARS = 200

/** The keys a create of this type takes (for the unknown-field error). */
export function createInputKeys(type: EngramType): string[] {
  const keys = ['content', 'scope']
  if (type !== 'status') keys.push('title')
  keys.push('tags', 'subjects')
  if (type === 'task') keys.push('status', 'parent_id')
  if (TASK_LINK_RELATION[type]) keys.push('task_id')
  if (type !== 'status' && type !== 'event' && type !== 'log') keys.push('supersedes')
  if (type === 'rule') keys.push('from_learning')
  return keys.concat(Object.keys(TYPE_FIELDS[type]).filter(k => !(type === 'task' && k === 'outcome')))
}

/** A log's START HERE fields are all there (written by eml_log since v0.19). */
export function hasStartHere(p: Record<string, unknown>): boolean {
  return typeof p.what === 'string' && typeof p.landed === 'string' && typeof p.next === 'string'
}

/**
 * The content of a log: the START HERE block rendered from its fields, then the
 * longer narrative (if any). The next session docks on the block.
 */
export function renderLogContent(p: Record<string, unknown>, narrative: string): string {
  if (!hasStartHere(p)) return narrative
  const threads = Array.isArray(p.open_threads) && p.open_threads.length > 0
    ? `\n\n**OPEN THREADS:**\n${(p.open_threads as string[]).map(t => `- ${t}`).join('\n')}`
    : ''
  const block = `## START HERE\n**WHAT:** ${p.what}\n\n**WHERE WE LANDED:** ${p.landed}\n\n**NEXT:** ${p.next}${threads}`
  return narrative && narrative.trim() !== '' ? `${block}\n\n${narrative}` : block
}

export class EngramStore {
  constructor(
    protected db: Database.Database,
    // v0.9.1 Cluster 1: namespace stays in the constructor as a display aid
    // (e.g. brain.name for logs). No longer used for filtering.
    protected namespace: string,
    protected projectStore?: ProjectStore,
    protected userStore?: UserStore,
    protected agentStore?: AgentStore,
    protected entityStore?: EntityStore,
    // v0.12: tag registry — used to validate that engram tags are registered.
    protected tagStore?: TagStore,
    // v0.14: subject registry — used to validate that engram subjects are registered.
    protected subjectStore?: SubjectStore,
    // v0.20: clock, ids and default actor (env.ts). Writes take it as a
    // parameter (default: this one, no actor); reads use its clock for review_due.
    protected env: Env = DEFAULT_ENV,
  ) {}

  /** The active log written in this session, if any (eml_log is one per session). */
  sessionLog(sessionId: string | null): Engram | null {
    if (!sessionId) return null
    const row = this.db.prepare(
      `SELECT * FROM engrams WHERE type = 'log' AND session_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any
    return row ? this.rowToEngram(row) : null
  }

  /** status_tracks of the scope's object (project, entity); agent / user / global have none. */
  statusTracksOf(scope: string): { hasObject: boolean, value: string | null } {
    const m = /^(project|entity)\.(.+)$/.exec(scope)
    if (!m) return { hasObject: false, value: null }
    const table = m[1] === 'project' ? 'projects' : 'entities'
    const row = this.db.prepare(`SELECT status_tracks FROM ${table} WHERE id = ?`).get(m[2]) as { status_tracks: string | null } | undefined
    return { hasObject: !!row, value: row?.status_tracks ?? null }
  }

  /** An engram's entries, oldest first (all kinds, or the ones asked for). */
  entries(id: string, kinds?: readonly EntryKind[]): Entry[] {
    return listEntries(this.db, id, kinds)
  }

  /**
   * The decisions and notes bound to a task (binding task), by the edge their
   * task_id drew. `statuses` defaults to active — the ones that close with it.
   */
  boundItems(taskId: string, statuses: readonly EngramStatus[] = ['active']): BoundItem[] {
    return this.db.prepare(`
      SELECT e.id, e.type, e.title, e.status FROM relations r
      JOIN engrams e ON e.id = r.source_id
      WHERE r.target_id = ? AND r.relation IN ('derived_from', 'refines')
        AND e.type IN ('decision', 'note')
        AND json_extract(e.properties, '$.binding') = 'task'
        AND e.status IN (${statuses.map(() => '?').join(', ')})
      ORDER BY e.created_at ASC
    `).all(taskId, ...statuses) as BoundItem[]
  }

  /**
   * v0.9.1 Cluster 1: namespaces filter is gone. The depth option is kept for
   * relations loading (irrelevant for the UI today but API-stable).
   */
  get(id: string, _options?: { depth?: number }): EngramWithRelations | null {
    const row = this.db.prepare(
      `SELECT * FROM engrams WHERE id = ?`
    ).get(id) as any
    if (!row) return null

    const engram = this.rowToEngram(row)
    this.hydrateFacets([engram])

    // v0.9.1 Cluster 1: relations are loaded without a namespace filter (no multi-tenancy).
    const rels = this.db.prepare(`
      SELECT r.*,
        c1.content as src_engram_content, c1.type as src_engram_type,
        c2.content as tgt_engram_content, c2.type as tgt_engram_type
      FROM relations r
      LEFT JOIN engrams c1 ON r.source_id = c1.id
      LEFT JOIN engrams c2 ON r.target_id = c2.id
      WHERE (r.source_id = ? OR r.target_id = ?)
    `).all(id, id) as any[]

    // v0.15: a task carries its journal, so a fresh session can take it over cold.
    // v0.19: every engram its entries (evidence, reviews); a task its bound items,
    // a learning its ripeness.
    const entries = this.entries(id)
    return {
      ...engram,
      relations: rels.map(r => this.rowToRelationWithTarget(r)),
      ...(entries.length > 0 ? { entries } : {}),
      ...(engram.type === 'task' ? { bound: this.boundItems(id) } : {}),
      ...(engram.type === 'learning' ? { learning: learningState(entries) } : {}),
    }
  }

  /**
   * All relations with at least one endpoint in `scope` — the edge set for a
   * scope-level relations graph. Includes cross-scope edges (one endpoint
   * outside the scope) so the caller can surface them as boundary/external
   * links. Plain Relation[] (no joined engram bodies) — nodes come separately.
   */
  relationsInScope(scope: string): Relation[] {
    const rows = this.db.prepare(`
      SELECT r.* FROM relations r
      WHERE r.source_id IN (SELECT id FROM engrams WHERE scope = ?)
         OR r.target_id IN (SELECT id FROM engrams WHERE scope = ?)
    `).all(scope, scope) as any[]
    return rows.map(r => this.rowToRelation(r))
  }

  /**
   * v0.12/v0.14: batch-load registered facet ids (tags + subjects) onto a set of
   * engrams IN PLACE — ONE query per facet for the whole array, not one per engram
   * (rowToEngram stays pure). Called at every read boundary (query/get/getRaw/
   * queryEngramsRaw) so all read paths expose them without an N+1.
   * Chunked to stay under SQLite's variable limit. v0.20: review_due, computed
   * at `now` (the read's clock), rides along.
   */
  protected hydrateFacets(engrams: Engram[], now: string = this.env.now()): void {
    hydrateEngramTags(this.db, engrams)
    hydrateEngramSubjects(this.db, engrams)
    hydrateReviewDue(this.db, engrams, now)
  }

  /**
   * v0.12: all engram↔tag memberships whose engram is in `scope` — the backbone
   * edge set for the cockpit graph's tag-hubs. One query (no N+1); nodes (engrams)
   * and the tag registry come separately.
   */
  engramTagsInScope(scope: string): Array<{ engram_id: string, tag_id: string }> {
    return this.db.prepare(`
      SELECT et.engram_id, et.tag_id
      FROM engram_tags et
      WHERE et.engram_id IN (SELECT id FROM engrams WHERE scope = ?)
    `).all(scope) as Array<{ engram_id: string, tag_id: string }>
  }

  query(q: EngramQuery): Engram[] {
    const conditions: string[] = []
    const params: any[] = []
    const now = q.now ?? this.env.now()

    // v0.9.1 Cluster 1: namespaces filter removed entirely — 1 user = 1 brain.

    if (q.scope) {
      conditions.push('c.scope = ?')
      params.push(q.scope)
    }
    if (q.scopes && q.scopes.length > 0) {
      conditions.push(`c.scope IN (${q.scopes.map(() => '?').join(', ')})`)
      params.push(...q.scopes)
    }
    if (q.title) {
      conditions.push('c.title = ?')
      params.push(q.title)
    }
    if (q.type) {
      conditions.push('c.type = ?')
      params.push(q.type)
    }
    // v0.10.5: status-set takes precedence over single status. recall passes
    // {active, planned} so live knowledge AND open work surface; list still
    // uses single `status` for precise filtering (incl. historical states).
    if (q.statuses && q.statuses.length > 0) {
      conditions.push(`c.status IN (${q.statuses.map(() => '?').join(', ')})`)
      params.push(...q.statuses)
    } else if (q.status) {
      conditions.push('c.status = ?')
      params.push(q.status)
    }
    if (q.significance) {
      conditions.push('c.significance = ?')
      params.push(q.significance)
    }
    if (q.before) {
      conditions.push('c.created_at < ?')
      params.push(q.before)
    }
    if (q.after) {
      conditions.push('c.created_at > ?')
      params.push(q.after)
    }
    // v0.10.5: FTS search. Tokens are phrase-quoted; joined by OR for fuzzy
    // recall, by space (implicit AND) for precise list-filtering. Default AND
    // preserves pre-v0.10.5 behaviour. A whitespace-only search yields zero
    // tokens → no text constraint (avoids MATCH '' which FTS5 rejects).
    const tokens = q.search
      ? q.search.split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`)
      : []
    const matchExpr = tokens.length > 0
      ? tokens.join(q.search_mode === 'or' ? ' OR ' : ' ')
      : null

    // v0.10.5: bm25 relevance ranking on the recall path (order_by='score' WITH
    // a search term). JOINs the FTS table to expose the bm25 rank so the LIMIT
    // keeps the most RELEVANT rows, not the newest. Every other path (list, and
    // the no-search score path) keeps the IN-subquery + its ordering unchanged.
    const bm25Path = q.order_by === 'score' && matchExpr !== null

    if (matchExpr !== null && !bm25Path) {
      conditions.push('c.id IN (SELECT id FROM engrams_fts WHERE engrams_fts MATCH ?)')
      params.push(matchExpr)
    }
    // v0.10.9 (audit C0): property-filters in SQL via json_extract, so LIMIT applies
    // AFTER filtering. Was a CLI post-LIMIT filter → matches past the limit silently dropped.
    if (q.due_before) {
      conditions.push("json_extract(c.properties, '$.due_date') < ?")
      params.push(q.due_before)
    }
    if (q.assignee) {
      conditions.push("json_extract(c.properties, '$.assignee_id') = ?")
      params.push(q.assignee)
    }
    if (q.priority) {
      conditions.push("json_extract(c.properties, '$.priority') = ?")
      params.push(q.priority)
    }
    if (q.change_type) {
      conditions.push("json_extract(c.properties, '$.change_type') = ?")
      params.push(q.change_type)
    }
    if (q.binding) {
      // v0.19: decisions / notes by binding; without one a decision or note is standing.
      conditions.push(q.binding === 'standing'
        ? "c.type IN ('decision', 'note') AND coalesce(json_extract(c.properties, '$.binding'), 'standing') = 'standing'"
        : "json_extract(c.properties, '$.binding') = ?")
      if (q.binding !== 'standing') params.push(q.binding)
    }
    if (q.learning_state) {
      // v0.19: a learning's state is computed from its evidence, so the matching
      // ids are resolved first and the LIMIT still applies after filtering.
      const ids = (this.db.prepare(`SELECT id FROM engrams WHERE type = 'learning'`).all() as Array<{ id: string }>)
        .map(r => r.id)
        .filter(id => learningState(this.entries(id)).state === q.learning_state)
      conditions.push(ids.length > 0 ? `c.id IN (${ids.map(() => '?').join(', ')})` : '0')
      params.push(...ids)
    }
    if (q.task_id) {
      // v0.19: everything a task_id write tied to this task (decisions, notes, events, …).
      conditions.push(`c.id IN (SELECT source_id FROM relations WHERE target_id = ? AND relation IN ('derived_from', 'refines'))`)
      params.push(q.task_id)
    }
    if (q.origin) {
      conditions.push('c.origin = ?')
      params.push(q.origin)
    }
    if (q.session_id) {
      conditions.push('c.session_id = ?')
      params.push(q.session_id)
    }
    if (q.stage) {
      // v0.15: task stage (a property, filtered like priority)
      conditions.push("json_extract(c.properties, '$.stage') = ?")
      params.push(q.stage)
    }
    if (q.tag) {
      // v0.12: membership filter — engrams carrying this registered tag. Slugify
      // the filter value so it matches stored slugs (writes normalize the same way).
      conditions.push('c.id IN (SELECT engram_id FROM engram_tags WHERE tag_id = ?)')
      params.push(slugifyTag(q.tag))
    }
    if (q.review_due !== undefined) {
      // v0.20: review due, computed at read time (review-due.ts) — the cockpit's
      // pending-reviews queue and badge, eml_list review_due=true, hygiene.
      conditions.push(q.review_due ? reviewDueSql('c') : `NOT ${reviewDueSql('c')}`)
      params.push(...reviewDueParams(now))
    }
    if (q.subject) {
      // v0.14: membership filter on the subjects axis (cross-scope strand)
      conditions.push('c.id IN (SELECT engram_id FROM engram_subjects WHERE subject_id = ?)')
      params.push(slugifySubject(q.subject))
    }
    if (q.has_relations === true) {
      conditions.push('(EXISTS (SELECT 1 FROM relations r WHERE (r.source_id = c.id OR r.target_id = c.id)))')
    } else if (q.has_relations === false) {
      conditions.push('(NOT EXISTS (SELECT 1 FROM relations r WHERE (r.source_id = c.id OR r.target_id = c.id)))')
    }

    // Order
    let orderClause: string
    if (bm25Path) {
      orderClause = 'fts.rank ASC' // bm25: more-negative = better, so ASC = best match first
    } else {
      switch (q.order_by) {
        case 'updated_at':     orderClause = 'c.updated_at DESC'; break
        case 'significance':   orderClause = "CASE c.significance WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'normal' THEN 3 WHEN 'low' THEN 2 WHEN 'trivial' THEN 1 END DESC"; break
        case 'score':          orderClause = 'c.created_at DESC'; break // score computed post-query
        case 'created_at':
        default:               orderClause = 'c.created_at DESC'; break
      }
    }

    const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '1=1'
    const fromClause = bm25Path
      ? 'engrams c JOIN (SELECT id, bm25(engrams_fts) AS rank FROM engrams_fts WHERE engrams_fts MATCH ?) fts ON fts.id = c.id'
      : 'engrams c'
    const sql = `SELECT ${bm25Path ? 'c.*, fts.rank AS bm25_rank' : 'c.*'} FROM ${fromClause} WHERE ${whereClause}
      ORDER BY ${orderClause} LIMIT ? OFFSET ?`
    // The bm25 MATCH param sits in the JOIN (before the WHERE conditions) → prepend it.
    const finalParams = bm25Path
      ? [matchExpr, ...params, q.limit ?? 20, q.offset ?? 0]
      : [...params, q.limit ?? 20, q.offset ?? 0]

    const rows = this.db.prepare(sql).all(...finalParams) as any[]

    // v0.10.5: bm25 sets the broad order; bucketByRelevance reorders comparably-
    // relevant hits by significance × recency (see the helper above).
    if (bm25Path) {
      const ranked = rows.map(r => ({ engram: this.rowToEngram(r), rank: r.bm25_rank as number }))
      this.hydrateFacets(ranked.map(x => x.engram), now)
      return bucketByRelevance(ranked, e => this.score(e), BM25_RELEVANCE_EPS)
    }

    let engrams = rows.map(r => this.rowToEngram(r))
    this.hydrateFacets(engrams, now)

    // Post-query: score-based sorting (significance × recency) — the no-search
    // score path (e.g. recall with an empty query) keeps the original behaviour.
    if (q.order_by === 'score') {
      engrams.sort((a, b) => this.score(b) - this.score(a))
    }

    return engrams
  }

  delete(id: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM engrams WHERE id = ?'
    ).run(id)
    if (result.changes > 0) {
      this.db.prepare('DELETE FROM engrams_fts WHERE id = ?').run(id)
      this.db.prepare(
        'DELETE FROM relations WHERE (source_id = ? OR target_id = ?)'
      ).run(id, id)
    }
    return result.changes > 0
  }

  /** A learning's ripeness from its evidence (brain hygiene, lists). */
  learningStateOf(id: string): LearningState {
    return learningState(this.entries(id))
  }


  /** Decisions and notes linked to a task by task_id, with the task's status (brain hygiene). */
  taskLinkedItems(): Array<{ id: string, task_status: string }> {
    return this.db.prepare(`
      SELECT e.id, t.status AS task_status FROM relations r
      JOIN engrams e ON e.id = r.source_id
      JOIN engrams t ON t.id = r.target_id AND t.type = 'task'
      WHERE r.relation IN ('derived_from', 'refines') AND e.type IN ('decision', 'note')
    `).all() as Array<{ id: string, task_status: string }>
  }

  /** How many engrams live in a scope (any type, any status) — object usage. */
  /** v0.20: an engram's revision counter, or undefined for an unknown id. */
  revOf(id: string): number | undefined {
    return (this.db.prepare('SELECT rev FROM engrams WHERE id = ?').get(id) as { rev: number } | undefined)?.rev
  }

  countInScope(scope: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM engrams WHERE scope = ?').get(scope) as { n: number }).n
  }

  /** Does an engram with this id exist? (for relate-target validation) */
  exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM engrams WHERE id = ?').get(id)
  }

  /**
   * v0.9 Cluster 4: generic BrainState for any scope.
   *
   * Works for `global`, `project.X`, `entity.X`, `agent.X`, `user.X`.
   * Returns a curated snapshot:
   *   - current_status: active status engrams in the scope (top 3 by updated_at DESC)
   *   - open_tasks: planned/active tasks in the scope, sorted by priority, due_date, last activity (limit 10)
   *   - recent_decisions: top 5 decisions by created_at DESC (not rendered by eml_show since v0.19)
   *   - recent_logs: top 5 logs by created_at DESC
   *   - relations: relations where source or target is in the scope (limit 20)
   *
   * The caller checks itself whether the scope exists (e.g. a project lookup
   * before the call, or an existence check via validate.ts). We only return the
   * engram snapshot here.
   */
  buildBrainState(scope: string): ScopedBrainState {
    const current_status = this.queryEngramsRaw(`
      SELECT * FROM engrams
      WHERE scope = ? AND type = 'status'
        AND status = 'active'
      ORDER BY updated_at DESC LIMIT 3
    `, [scope])

    const now = this.env.now()
    const open_tasks = this.queryEngramsRaw(OPEN_TASKS_IN_SCOPE_SQL, [scope, now], now)
    const open_tasks_total = (this.db.prepare(OPEN_TASKS_COUNT_SQL).get(scope, now) as { n: number }).n
    const backlog_tasks = (this.db.prepare(BACKLOG_COUNT_SQL).get(scope, now) as { n: number }).n

    // v0.10.5: recency, not significance — orientation wants the decisions that
    // are live in current work, not the biggest strategic ones (titles-only in render).
    const recent_decisions = this.queryEngramsRaw(`
      SELECT * FROM engrams
      WHERE scope = ? AND type = 'decision'
      ORDER BY created_at DESC
      LIMIT 5
    `, [scope])

    const recent_logs = this.queryEngramsRaw(`
      SELECT * FROM engrams
      WHERE scope = ? AND type = 'log'
      ORDER BY created_at DESC LIMIT 5
    `, [scope])

    // v0.10.5: active rules in scope — name-only in the dashboard render. (relations
    // dropped from the dashboard: noise for orientation, reachable via eml_get --with-relations.)
    const rules = this.queryEngramsRaw(`
      SELECT * FROM engrams
      WHERE scope = ? AND type = 'rule' AND status = 'active'
      ORDER BY created_at DESC LIMIT 15
    `, [scope])

    // v0.13: engrams in scope that are review due (review-due.ts: standing
    // decision/rule/profile past review_due_at, active task idle too long) —
    // the staleness queue. Kept SEPARATE from open_tasks so it never pollutes
    // the real todo list.
    const pending_reviews = this.queryEngramsRaw(`
      SELECT c.* FROM engrams c
      WHERE c.scope = ? AND ${reviewDueSql('c')}
      ORDER BY datetime(json_extract(c.properties, '$.review_due_at')) ASC
      LIMIT 15
    `, [scope, ...reviewDueParams(now)], now)

    // v0.19: the scope's object (project / entity).
    const m = /^(project|entity)\.(.+)$/.exec(scope)
    const object = m
      ? this.db.prepare(`SELECT status_tracks, metadata FROM ${m[1] === 'project' ? 'projects' : 'entities'} WHERE id = ?`).get(m[2]) as { status_tracks: string | null, metadata: string | null } | undefined
      : undefined
    return {
      scope, current_status, open_tasks, open_tasks_total, backlog_tasks, recent_decisions, recent_logs, rules, pending_reviews,
      status_tracks: object?.status_tracks ?? null,
      metadata: object?.metadata ? JSON.parse(object.metadata) : null,
    }
  }

  // === Private ===

  protected queryEngramsRaw(sql: string, params: any[], now?: string): Engram[] {
    const engrams = (this.db.prepare(sql).all(...params) as any[]).map(r => this.rowToEngram(r))
    this.hydrateFacets(engrams, now)
    return engrams
  }

  protected rowToRelation(row: any): Relation {
    return {
      id: row.id,
      source_id: row.source_id,
      target_id: row.target_id,
      relation: row.relation,
      detection_method: row.detection_method,
      strength: row.strength,
      explanation: row.explanation ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      created_at: row.created_at,
    }
  }

  protected getRaw(id: string): Engram | null {
    const row = this.db.prepare(
      'SELECT * FROM engrams WHERE id = ?'
    ).get(id) as any
    if (!row) return null
    const engram = this.rowToEngram(row)
    this.hydrateFacets([engram])
    return engram
  }

  protected score(engram: Engram): number {
    // v0.8 C7: no decay_factor on the engram anymore (decay mechanism not activated).
    const sig = significanceWeight(engram.significance)
    const recency = recencyBoost(engram.created_at, Date.parse(this.env.now()))
    return sig * recency
  }

  protected rowToEngram(row: any): Engram {
    // v0.9 Cluster 1: namespace column dropped (Phase 1.4).
    // v0.11 team-brains: ingested_by IS now exposed — it carries the server-stamped
    // authorship handle (caller, = tokens.name) so readers see who wrote an engram
    // in a shared brain. Pre-v0.11 rows have NULL/legacy values (legacy brain audit trail).
    // v0.10.5: bm25_rank is a transient ranking column on the recall path — drop
    // it so it never leaks into the Engram (harmless no-op on every other path).
    const { bm25_rank: _r, ...rest } = row
    return {
      ...rest,
      properties: row.properties ? JSON.parse(row.properties) : null,
      // v0.12/v0.14: tags, subjects and review_due are batch-hydrated at the
      // read boundary (hydrateFacets) so the row mapper stays pure — no per-row
      // query. Defaults until hydrated.
      tags: [],
      subjects: [],
      review_due: false,
    }
  }

  protected rowToRelationWithTarget(row: any): RelationWithTarget {
    return {
      id: row.id,
      source_id: row.source_id,
      target_id: row.target_id,
      relation: row.relation,
      detection_method: row.detection_method,
      strength: row.strength,
      explanation: row.explanation ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      created_at: row.created_at,
      ...(row.src_engram_content ? { source_engram: { content: row.src_engram_content, type: row.src_engram_type } } : {}),
      ...(row.tgt_engram_content ? { target_engram: { content: row.tgt_engram_content, type: row.tgt_engram_type } } : {}),
    }
  }
}
