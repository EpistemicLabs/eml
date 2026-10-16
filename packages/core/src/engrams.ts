import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import {
  Engram, EngramInput, EngramQuery, EngramWithRelations,
  Relation, RelationWithTarget, RelationInput, ScopedBrainState,
  TYPE_DEFAULT_STATUS, TYPE_REVIEW_DEFAULTS,
  EngramType, ConflictCandidate, StoredEngram, DetectionMethod,
  EngramStatus, TaskEntry, TaskStage, OpenSubtask,
  TASK_STAGES, TASK_OPEN_STATUSES, TASK_INACTIVITY_DAYS, TASK_LINK_RELATION,
} from './types'
import { significanceWeight, recencyBoost } from './decay'
import { validateEngramType, validateProperties, validateFormat, validateScopePattern, validateScopeExists, validateNoTemplateLeak } from './validate'
import { ProjectStore } from './projects'
import { UserStore } from './users'
import { AgentStore } from './agents'
import { EntityStore } from './entities'
import { TagStore, slugifyTag, hydrateEngramTags } from './tags'
import { hydrateEngramLabels, slugifyLabel } from './labels'
import { SubjectStore, slugifySubject, hydrateEngramSubjects } from './subjects'
import { OPEN_TASKS_IN_SCOPE_SQL } from './open-tasks'

// v0.9 Cluster 1: namespace concept removed entirely (Phase 1.3 code, Phase 1.4 DB).

/** v0.13: the staleness-review label id — member #1 of the labels axis. */
export const REVIEW_LABEL = 'review'
/**
 * v0.13: engram types eligible for the review sweep = the keys of
 * TYPE_REVIEW_DEFAULTS. Single source of truth — adding a reviewable type there
 * makes the sweep + pending_reviews pick it up, no SQL edit.
 */
export const REVIEWABLE_TYPES = Object.keys(TYPE_REVIEW_DEFAULTS) as EngramType[]

/**
 * v0.13: parse `properties.supersedes` (declared at write time) into a clean
 * list of engram ids. Tolerant of the field being absent / malformed — a bad
 * shape yields [] rather than throwing, so a stray value never breaks a write.
 */
export function extractSupersedesIds(properties: unknown): string[] {
  if (!properties || typeof properties !== 'object') return []
  const raw = (properties as Record<string, unknown>).supersedes
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

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

/** Written types that get a conflict scan; log/event are excluded (immutable/append-only). */
export const CONFLICT_TYPES: ReadonlySet<EngramType> = new Set<EngramType>([
  'decision', 'status', 'rule', 'reference', 'note', 'task',
])
/** Coverage gate, calibrated ≈0.5 (live-brain eval-set 2026-06-05; revisit task 1ce18eb9). */
export const CONFLICT_COVERAGE_THRESHOLD = 0.5
/** Over-fetch generously, THEN filter, THEN cap — never SQL limit:N then post-filter (the C0 bug class). */
export const CONFLICT_CANDIDATE_LIMIT = 25
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

export class EngramStore {
  constructor(
    private db: Database.Database,
    // v0.9.1 Cluster 1: namespace stays in the constructor as a display aid
    // (e.g. brain.name for logs). No longer used for filtering.
    private namespace: string,
    private projectStore?: ProjectStore,
    private userStore?: UserStore,
    private agentStore?: AgentStore,
    private entityStore?: EntityStore,
    // v0.12: tag registry — used to validate that engram tags are registered.
    private tagStore?: TagStore,
    // v0.14: subject registry — used to validate that engram subjects are registered.
    private subjectStore?: SubjectStore
  ) {}

  /**
   * v0.8 C3: hard scope validation (was: soft warning).
   * Pattern check + existence check via validate.ts.
   * Throws on an invalid pattern or an unknown project/user/agent/entity.
   * scope='global' gets no existence check (see validateScopeExists).
   */
  private validateScope(scope: string): void {
    validateScopePattern(scope)
    validateScopeExists(scope, {
      projects: this.projectStore,
      users:    this.userStore,
      agents:   this.agentStore,
      entities: this.entityStore,
    })
  }

  store(input: EngramInput, caller: string | null = null): StoredEngram {
    // Reject unknown types with a readable error before the DB CHECK would.
    validateEngramType(input.type)

    // v0.8 C1: TYPE_DEFAULT_STATUS — task defaults to 'planned', everything else to 'active'.
    const status = input.status ?? TYPE_DEFAULT_STATUS[input.type] ?? 'active'

    // v0.8 C9: review_due_at default for decision/rule/profile.
    // Sets the default only when the input has no review_due_at — explicit overrides.
    const reviewDays = TYPE_REVIEW_DEFAULTS[input.type]
    if (reviewDays !== undefined) {
      const props = (input.properties ?? {}) as Record<string, unknown>
      if (!props.review_due_at) {
        const due = new Date(Date.now() + reviewDays * 86400_000).toISOString()
        input = { ...input, properties: { ...props, review_due_at: due } }
      }
    }

    // v0.10.4: reject tool-call template leak in content (agent-bug guard)
    validateNoTemplateLeak(input.content)

    // create=true: create-only requirements are enforced (v0.15 decision
    // alternatives + rationale).
    validateProperties(input.type, input.properties as Record<string, unknown> | undefined, status, { create: true })
    // Rules and profiles in the short format (validate.ts, validateFormat).
    validateFormat(input.type, input.content, input.properties as Record<string, unknown> | undefined)

    // v0.8 C3: Hard scope validation (Pattern + Existence)
    this.validateScope(input.scope)

    // v0.12: normalize + validate tags before the insert (unknown → reject the
    // whole write, same failure shape as an unknown scope).
    const tagSlugs = input.tags !== undefined ? this.normalizeAndValidateTags(input.tags) : undefined
    // v0.14: same for subjects
    const subjectSlugs = input.subjects !== undefined ? this.normalizeAndValidateSubjects(input.subjects) : undefined

    // v0.15: only a task can have a parent task (the rest of the part_of rules
    // run inside the transaction, against the inserted row).
    if (input.parent_id !== undefined && input.type !== 'task') {
      throw new Error('Invalid engram: part_of needs two tasks.')
    }
    // v0.15: task-linked write — check type and task up front, so a bad task_id
    // fails before anything is written.
    const taskLink = input.task_id !== undefined ? TASK_LINK_RELATION[input.type] : undefined
    if (input.task_id !== undefined) {
      if (!taskLink) {
        throw new Error(`Invalid engram: task_id links a decision or note to a task — not available for type ${input.type}.`)
      }
      const target = this.db.prepare('SELECT type FROM engrams WHERE id = ?').get(input.task_id) as { type: string } | undefined
      if (target?.type !== 'task') throw new Error(`Invalid engram: task_id ${input.task_id} is not a task.`)
    }

    const id = uuid()
    const now = new Date().toISOString()
    let wikilinks: { resolved: string[]; unresolved: string[] } = { resolved: [], unresolved: [] }
    const openSubtasks: OpenSubtask[] = []

    // v0.10.10 L1: engram INSERT, FTS sync and auto-supersede atomic in ONE
    // transaction — a mid-write failure (e.g. the FTS insert) rolls back the engram
    // insert instead of leaving an FTS desync or a half-supersede behind.
    // v0.9 Cluster 1: namespace column dropped.
    // v0.11 team-brains: ingested_by is stamped from `caller` — the authorship
    // handle the server derived from the authenticated token (tokens.name), NOT
    // from client input. In a shared (team) brain this makes per-engram authorship
    // unforgeable: the token-holder can't claim a foreign author. null on the
    // in-process/legacy path (no caller) preserves the prior NULL behaviour.
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO engrams (
          id, content, type,
          scope, title,
          status, significance, properties,
          ingested_by, ingestion_method, session_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.content, input.type,
        input.scope, input.title ?? null,
        status, input.significance ?? 'normal',
        input.properties ? JSON.stringify(input.properties) : null,
        caller, input.ingestion_method ?? null, input.session_id ?? null,
        now, now
      )

      // Sync FTS
      this.db.prepare(`
        INSERT INTO engrams_fts (id, content, scope, title)
        VALUES (?, ?, ?, ?)
      `).run(id, input.content, input.scope, input.title ?? '')

      // v0.8 C1: auto-supersede for the status type, match key (scope) — namespace dropped.
      if (input.type === 'status' && status === 'active') {
        this.autoSupersedeStatusEngrams(id, input.scope)
      }

      // v0.13: explicit supersede for ANY type. When a write declares
      // `properties.supersedes: [id,…]`, flip each prior engram + draw the
      // `supersedes` edge — the status-type mechanism above, generalised to any
      // type via the caller's explicit declaration (never inferred from title,
      // which is also how a series threads). Skip self / non-existent targets so
      // a stale id can't dangle an edge.
      for (const oldId of extractSupersedesIds(input.properties)) {
        if (oldId === id) continue
        const exists = this.db.prepare(`SELECT 1 FROM engrams WHERE id = ?`).get(oldId)
        if (exists) {
          this.linkSupersede(id, oldId, 'agent_declared')
          // v0.15: superseding a parent task does not cascade — list its open sub-tasks.
          openSubtasks.push(...this.openSubtasksOf(oldId))
        }
      }

      // v0.15: parent task → part_of edge, atomic with the insert.
      if (input.parent_id !== undefined) this.linkPartOf(id, input.parent_id)

      // v0.15: task-linked write → edge to the task + a task entry, same
      // transaction (no decision without its edge or entry). The stage is not
      // advanced — whether all decisions are in is for the human or agent to say.
      if (input.task_id !== undefined && taskLink) {
        this.db.prepare(`
          INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, created_at)
          VALUES (?, ?, ?, ?, 'agent_declared', 1.0, datetime('now'))
          ON CONFLICT(source_id, target_id, relation) DO NOTHING
        `).run(uuid(), id, input.task_id, taskLink)
        const label = input.title ?? (input.content.length > 80 ? `${input.content.slice(0, 80)}…` : input.content)
        const verb = input.type === 'decision' ? 'taken' : 'written'
        this.appendTaskEntry(input.task_id, { text: `${input.type} ${verb}: ${label} (${id})` }, caller)
      }

      // v0.12: tag memberships (normalized + validated pre-transaction above)
      if (tagSlugs && tagSlugs.length > 0) this.insertEngramTags(id, tagSlugs)
      // v0.14: subject memberships (normalized + validated pre-transaction above)
      if (subjectSlugs && subjectSlugs.length > 0) this.insertEngramSubjects(id, subjectSlugs)
      // v0.14 Cluster C: materialize [[wikilinks]] in content into related_to edges
      wikilinks = this.materializeWikilinks(id, input.content, input.scope)
    })()

    if (wikilinks.unresolved.length > 0) {
      console.warn(`[EML] unresolved wikilink(s) in engram ${id}: ${wikilinks.unresolved.map(t => `[[${t}]]`).join(' ')}`)
    }

    // v0.10.9: write-time conflict guardrail. Advisory — never blocks the write.
    // Only knowledge-bearing types are scanned; field is attached only when non-empty.
    const stored = this.getRaw(id)!
    const unresolved = wikilinks.unresolved.length > 0 ? { unresolved_links: wikilinks.unresolved } : {}
    const subtasks = openSubtasks.length > 0 ? { open_subtasks: openSubtasks } : {}
    if (CONFLICT_TYPES.has(input.type)) {
      const potential_conflicts = this.findPotentialConflicts(stored)
      if (potential_conflicts.length > 0) return { ...stored, potential_conflicts, ...unresolved, ...subtasks }
    }
    return { ...stored, ...unresolved, ...subtasks }
  }

  // === v0.15: task hierarchy (part_of) ===

  /**
   * The part_of rules (the DB guards only the verb): both ends are tasks, no
   * cycles, at most one parent per task. Re-drawing the existing edge is fine
   * (idempotent). Errors start with `Invalid engram:`.
   */
  private assertPartOf(childId: string, parentId: string): void {
    const typeOf = (id: string) =>
      (this.db.prepare('SELECT type FROM engrams WHERE id = ?').get(id) as { type: string } | undefined)?.type
    if (typeOf(childId) !== 'task' || typeOf(parentId) !== 'task') {
      throw new Error('Invalid engram: part_of needs two tasks.')
    }
    if (childId === parentId) throw new Error('Invalid engram: part_of would create a cycle.')
    const parentOf = (id: string) =>
      (this.db.prepare(
        `SELECT target_id FROM relations WHERE source_id = ? AND relation = 'part_of'`,
      ).get(id) as { target_id: string } | undefined)?.target_id
    const current = parentOf(childId)
    if (current !== undefined && current !== parentId) {
      throw new Error(`Invalid engram: task ${childId} already has a parent.`)
    }
    // Walk up from the new parent: reaching the child means the edge closes a loop.
    const seen = new Set<string>()
    for (let p: string | undefined = parentId; p !== undefined; p = parentOf(p)) {
      if (p === childId) throw new Error('Invalid engram: part_of would create a cycle.')
      if (seen.has(p)) break
      seen.add(p)
    }
  }

  /** Validate + draw child → parent. Returns true if the edge is new. */
  private linkPartOf(childId: string, parentId: string): boolean {
    this.assertPartOf(childId, parentId)
    const info = this.db.prepare(`
      INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, created_at)
      VALUES (?, ?, ?, 'part_of', 'agent_declared', 1.0, datetime('now'))
      ON CONFLICT(source_id, target_id, relation) DO NOTHING
    `).run(uuid(), childId, parentId)
    this.dropWikilinkEcho(childId, parentId)
    return info.changes > 0
  }

  /** Open (planned/active) direct sub-tasks of a task. */
  private openSubtasksOf(parentId: string): OpenSubtask[] {
    const rows = this.db.prepare(`
      SELECT e.id, e.title FROM relations r
      JOIN engrams e ON e.id = r.source_id
      WHERE r.target_id = ? AND r.relation = 'part_of'
        AND e.type = 'task' AND e.status IN (${TASK_OPEN_STATUSES.map(() => '?').join(', ')})
      ORDER BY e.created_at ASC
    `).all(parentId, ...TASK_OPEN_STATUSES) as Array<{ id: string, title: string | null }>
    return rows.map(r => ({ parent_id: parentId, id: r.id, title: r.title }))
  }

  /**
   * Invalidating a parent invalidates its open sub-tasks, recursively, with
   * outcome "parent invalidated". Raw writes (no re-validation) inside the
   * caller's transaction; each child loses its review label like any closed task.
   */
  private cascadeInvalidate(parentId: string): void {
    for (const child of this.openSubtasksOf(parentId)) {
      const row = this.db.prepare('SELECT properties FROM engrams WHERE id = ?').get(child.id) as { properties: string | null }
      const props = row.properties ? JSON.parse(row.properties) : {}
      props.outcome = 'parent invalidated'
      this.db.prepare(`
        UPDATE engrams SET status = 'invalidated', properties = ?, updated_at = datetime('now') WHERE id = ?
      `).run(JSON.stringify(props), child.id)
      this.stripReviewLabel(child.id)
      this.cascadeInvalidate(child.id)
    }
  }

  // === v0.15: task entries ===

  /**
   * Append one entry to a task's journal. Append-only, stamped with time and
   * author (the caller's handle). A `stage` sets the task's stage in the same
   * transaction (a movement like any patch). Any entry is a movement: it clears
   * the inactivity `review` label. Returns null if the id is unknown.
   */
  appendTaskEntry(
    taskId: string,
    input: { text: string, stage?: string },
    author: string | null = null,
  ): TaskEntry | null {
    const task = this.db.prepare('SELECT type, status, properties FROM engrams WHERE id = ?').get(taskId) as
      { type: string, status: string, properties: string | null } | undefined
    if (!task) return null
    if (task.type !== 'task') throw new Error(`Invalid engram: task_id ${taskId} is not a task.`)
    if (typeof input.text !== 'string' || input.text.trim() === '') {
      throw new Error('Invalid engram: a task entry needs text.')
    }
    if (input.stage !== undefined && !(TASK_STAGES as readonly string[]).includes(input.stage)) {
      throw new Error(`Invalid engram: stage must be one of ${TASK_STAGES.join(', ')}.`)
    }
    const currentStage = (task.properties ? JSON.parse(task.properties).stage : undefined) as TaskStage | undefined

    const entry: TaskEntry = {
      id: uuid(),
      task_id: taskId,
      at: new Date().toISOString(),
      author,
      stage: (input.stage as TaskStage | undefined) ?? currentStage ?? null,
      text: input.text,
    }
    this.db.transaction(() => {
      // update() enforces the frozen-on-close rule and clears the review label.
      if (input.stage !== undefined && input.stage !== currentStage) {
        this.update(taskId, { properties: { stage: input.stage } })
      }
      this.db.prepare(`
        INSERT INTO task_entries (id, task_id, at, author, stage, text) VALUES (?, ?, ?, ?, ?, ?)
      `).run(entry.id, entry.task_id, entry.at, entry.author, entry.stage, entry.text)
      this.stripReviewLabel(taskId)
    })()
    return entry
  }

  /** A task's journal, oldest first. */
  taskEntries(taskId: string): TaskEntry[] {
    return this.db.prepare(
      'SELECT id, task_id, at, author, stage, text FROM task_entries WHERE task_id = ? ORDER BY at ASC, rowid ASC',
    ).all(taskId) as TaskEntry[]
  }

  /**
   * v0.10.9: surface active same-scope engrams the just-written engram may
   * duplicate/contradict. Deterministic, FTS-based, advisory (the agent judges).
   *
   * Order is load-bearing: over-fetch FTS candidates (BM25-ranked), THEN exclude
   * self / same-title / log+event, THEN drop below the coverage gate, THEN cap
   * at N=3. Filtering happens BEFORE the cap — never SQL limit:3 then post-filter,
   * which would let a real conflict at FTS-rank 4+ go unseen (the C0 bug class).
   */
  private findPotentialConflicts(engram: Engram): ConflictCandidate[] {
    const salient = extractSalientTerms(engram.title, engram.content)
    if (salient.length === 0) return []

    // search_mode 'or' = fuzzy recall path (NOT list's implicit AND); order_by
    // 'score' = BM25 ranking. Generous limit → over-fetch; the typed+scoped
    // candidate set is tiny, so this stays cheap.
    const candidates = this.query({
      search: salient.join(' '),
      search_mode: 'or',
      scope: engram.scope,
      statuses: ['active'],
      order_by: 'score',
      limit: CONFLICT_CANDIDATE_LIMIT,
    })

    const survivors: ConflictCandidate[] = []
    for (const c of candidates) {
      if (c.id === engram.id) continue                                   // self
      if (c.title !== null && c.title === engram.title) continue   // same-title (thread, not conflict)
      if (c.type === 'log' || c.type === 'event') continue               // never a supersede/merge target
      const coverage = termCoverage(salient, `${c.title ?? ''} ${c.content}`)
      if (coverage < CONFLICT_COVERAGE_THRESHOLD) continue               // the load-bearing gate
      survivors.push({
        id: c.id,
        type: c.type,
        title: c.title,
        gist: c.content.slice(0, 200),
        overlap: 'fts',
        coverage: Math.round(coverage * 100) / 100,
      })
    }

    // Cap by COVERAGE, not BM25 order. BM25 ranks retrieval, but coverage is the
    // precision/escalation metric (the banner escalates on the max-coverage survivor).
    // If >N candidates clear the gate, trimming in BM25 order could drop a
    // near-identical (high-coverage) hit that BM25 ranked 4+, silently suppressing
    // the escalation exactly when it matters. Sort coverage-desc, then cap the tail.
    survivors.sort((a, b) => b.coverage - a.coverage)
    return survivors.slice(0, CONFLICT_MAX)
  }

  /**
   * v0.8 C1: auto-supersede.
   * v0.9.1 Cluster 1: match key is just (scope) now, namespace is gone.
   */
  private autoSupersedeStatusEngrams(newId: string, scope: string): void {
    const oldRows = this.db.prepare(`
      SELECT id FROM engrams
      WHERE scope = ?
        AND type = 'status' AND status = 'active'
        AND id != ?
    `).all(scope, newId) as { id: string }[]

    for (const old of oldRows) this.linkSupersede(newId, old.id, 'manual')
  }

  /**
   * v0.14 Cluster C: resolve one wikilink target to an engram id.
   * Matches an exact title, the slugified title (so `[[V014T-Target]]` finds
   * `v014t-target` — case-insensitive, consistent with tag/subject filters), an
   * exact id, or an id-prefix (≥8 chars so a short token can't fan out).
   * Ordering: the source engram's own scope first, then active, then most-recent
   * — so a `[[link]]` in a project note prefers the same-project engram over a
   * same-named one elsewhere. May resolve to the source itself; the caller skips
   * a self-match. `ambiguous` = the matches span more than one scope (a genuine
   * cross-scope collision worth a warning; a same-scope thread is not ambiguous).
   */
  private resolveWikilinkTarget(target: string, sourceScope: string): { id: string | null; ambiguous: boolean } {
    const slug = slugifyTag(target)          // same slugify as tags/subjects: lowercased kebab
    const low = target.toLowerCase()         // ids are lowercase hex → case-insensitive id match
    const rows = this.db.prepare(`
      SELECT id, scope FROM engrams
      WHERE title = ? OR title = ? OR id = ? OR (length(?) >= 8 AND id LIKE ? || '%')
      ORDER BY (scope = ?) DESC, (status = 'active') DESC, updated_at DESC
    `).all(target, slug, low, low, low, sourceScope) as Array<{ id: string; scope: string }>
    if (rows.length === 0) return { id: null, ambiguous: false }
    return { id: rows[0].id, ambiguous: new Set(rows.map(r => r.scope)).size > 1 }
  }

  /**
   * v0.14 Cluster C: materialize `[[target]]` links in `content` into idempotent
   * `related_to` edges (sourceId → resolved id, detection_method 'agent_declared',
   * metadata {source:'wikilink'} so they stay distinguishable from manual
   * eml_relate edges). ADD-ONLY: it upserts, never deletes — so a later content
   * edit that ADDS a link accrues its edge (the operative gap, §C.1) without ever
   * clobbering a manually drawn `related_to` edge. Idempotent via ON CONFLICT.
   * MUST run inside the caller's transaction. Returns resolved + unresolved
   * targets (unresolved are logged + surfaced on the write response, never dropped;
   * a cross-scope-ambiguous resolution is warned).
   */
  private materializeWikilinks(sourceId: string, content: string, sourceScope: string): { resolved: string[]; unresolved: string[] } {
    const resolved: string[] = []
    const unresolved: string[] = []
    const ins = this.db.prepare(`
      INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, metadata, created_at)
      VALUES (?, ?, ?, 'related_to', 'agent_declared', 1.0, ?, datetime('now'))
      ON CONFLICT(source_id, target_id, relation) DO NOTHING
    `)
    // v0.17: related_to is only the fallback — a link to an engram this one is
    // already tied to by a typed edge (refines / derived_from from task_id,
    // supersedes, …) would just repeat it.
    const typed = this.db.prepare(
      `SELECT 1 FROM relations WHERE source_id = ? AND target_id = ? AND relation <> 'related_to' LIMIT 1`,
    )
    const META = JSON.stringify({ source: 'wikilink' })
    for (const target of extractWikilinkTargets(content)) {
      const { id: targetId, ambiguous } = this.resolveWikilinkTarget(target, sourceScope)
      if (!targetId) { unresolved.push(target); continue }
      if (targetId === sourceId) continue   // self-reference (only self matched) → skip silently
      if (ambiguous) {
        console.warn(`[EML] ambiguous wikilink [[${target}]] in engram ${sourceId} → ${targetId} (matches span multiple scopes; use an id to disambiguate)`)
      }
      if (!typed.get(sourceId, targetId)) ins.run(uuid(), sourceId, targetId, META)
      resolved.push(targetId)
    }
    return { resolved, unresolved }
  }

  /**
   * v0.17: a typed edge makes the wikilink's related_to for the same pair
   * redundant — drop it. An explicitly drawn related_to (eml_relate) stays.
   */
  private dropWikilinkEcho(sourceId: string, targetId: string): void {
    this.db.prepare(`
      DELETE FROM relations
      WHERE source_id = ? AND target_id = ? AND relation = 'related_to'
        AND json_extract(metadata, '$.source') = 'wikilink'
    `).run(sourceId, targetId)
  }

  /**
   * v0.13: flip one prior engram to `superseded` and materialize the
   * `supersedes` edge (newId → oldId). Shared by the status-type auto-supersede
   * (Match-Key = scope) and the explicit `properties.supersedes` path (any type,
   * declared at write time). The `status != 'superseded'` guard keeps re-writes
   * idempotent; the edge INSERT is idempotent via ON CONFLICT. MUST run inside
   * store()'s transaction so the flip + edge commit atomically with the new row.
   */
  private linkSupersede(newId: string, oldId: string, detection: DetectionMethod): void {
    this.db.prepare(`
      UPDATE engrams SET status = 'superseded', updated_at = datetime('now')
      WHERE id = ? AND status != 'superseded'
    `).run(oldId)
    this.db.prepare(`
      INSERT INTO relations (id, source_id, target_id,
        relation, detection_method, strength, created_at)
      VALUES (?, ?, ?, 'supersedes', ?, 1.0, datetime('now'))
      ON CONFLICT(source_id, target_id, relation) DO NOTHING
    `).run(uuid(), newId, oldId, detection)
    this.dropWikilinkEcho(newId, oldId)
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

    return {
      ...engram,
      relations: rels.map(r => this.rowToRelationWithTarget(r)),
      // v0.15: a task carries its journal, so a fresh session can take it over cold
      ...(engram.type === 'task' ? { entries: this.taskEntries(id) } : {}),
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
   * v0.12/v0.13/v0.14: batch-load registered facet ids (tags + labels + subjects) onto a set of
   * engrams IN PLACE — ONE query per facet for the whole array, not one per engram
   * (rowToEngram stays pure). Called at every read boundary (query/get/getRaw/
   * queryEngramsRaw) so all read paths expose tags AND labels without an N+1.
   * Chunked to stay under SQLite's variable limit.
   */
  private hydrateFacets(engrams: Engram[]): void {
    hydrateEngramTags(this.db, engrams)
    hydrateEngramLabels(this.db, engrams)
    hydrateEngramSubjects(this.db, engrams)
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

  /**
   * v0.12: normalize incoming tag ids to slugs (consistent with tag creation, so
   * ["Deploy"] resolves to "deploy") and validate them all against the registry in
   * ONE query. Throws naming EVERY unknown tag; returns the normalized slug list to
   * persist. Enforces "only registered tags are usable" at the write path.
   */
  private normalizeAndValidateTags(tags: string[]): string[] {
    const slugs: string[] = []
    const invalid: string[] = []
    for (const t of tags) {
      const s = slugifyTag(t)
      if (s) slugs.push(s)
      else invalid.push(t)               // unslugifiable → reject, never silently drop
    }
    if (invalid.length > 0) {
      throw new Error(
        `invalid tag name "${invalid.join('", "')}" — a tag must contain at least one letter or digit`
      )
    }
    if (slugs.length === 0) return []
    const known = this.tagStore?.existingIds(slugs) ?? new Set<string>()
    const unknown = [...new Set(slugs)].filter(s => !known.has(s))
    if (unknown.length > 0) {
      throw new Error(
        `tag "${unknown.join('", "')}" not found — create it via the tag registry first`
      )
    }
    return slugs
  }

  private insertEngramTags(engramId: string, tags: string[]): void {
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO engram_tags (engram_id, tag_id) VALUES (?, ?)'
    )
    for (const t of tags) ins.run(engramId, t)
  }

  /**
   * v0.14: normalize incoming subject ids to slugs and validate them against the
   * subject registry in ONE query — the tag rules (unknown → reject, naming every
   * unknown one). A CLOSED subject is accepted: filing an engram into a finished
   * strand after the fact is legitimate; the server surfaces a notice.
   */
  private normalizeAndValidateSubjects(subjects: string[]): string[] {
    const slugs: string[] = []
    const invalid: string[] = []
    for (const t of subjects) {
      const s = slugifySubject(t)
      if (s) slugs.push(s)
      else invalid.push(t)
    }
    if (invalid.length > 0) {
      throw new Error(
        `invalid subject name "${invalid.join('", "')}" — a subject must contain at least one letter or digit`
      )
    }
    if (slugs.length === 0) return []
    const known = this.subjectStore?.statusByIds(slugs) ?? new Map()
    const unknown = [...new Set(slugs.filter(s => !known.has(s)))]
    if (unknown.length > 0) {
      throw new Error(
        `subject "${unknown.join('", "')}" not found — create it via the subject registry first`
      )
    }
    return [...new Set(slugs)]
  }

  private insertEngramSubjects(engramId: string, subjects: string[]): void {
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO engram_subjects (engram_id, subject_id) VALUES (?, ?)'
    )
    for (const t of subjects) ins.run(engramId, t)
  }

  /** v0.14: full-set replace of an engram's subject memberships (update semantics). */
  private replaceEngramSubjects(engramId: string, subjects: string[]): void {
    this.db.prepare('DELETE FROM engram_subjects WHERE engram_id = ?').run(engramId)
    this.insertEngramSubjects(engramId, subjects)
  }

  /** v0.12: full-set replace of an engram's tag memberships (update semantics). */
  private replaceEngramTags(engramId: string, tags: string[]): void {
    this.db.prepare('DELETE FROM engram_tags WHERE engram_id = ?').run(engramId)
    this.insertEngramTags(engramId, tags)
  }

  /**
   * v0.13: deterministic staleness-review sweep (labels axis). Stamps the `review`
   * label on every active decision/rule/profile whose review_due_at has passed and
   * that isn't already flagged. Pure date-compare — NO LLM. Idempotent
   * (INSERT OR IGNORE + NOT EXISTS guard), so re-running is a cheap no-op.
   *
   * ADD-ONLY by design: it never strips a label, so a future manually-set flag (or
   * a not-yet-due engram) is safe from the sweep. Removal is explicit — see
   * stripReviewLabel (confirmReview + status transitions off 'active').
   *
   * v0.15: second criterion for open tasks — inactivity, not a due date (see
   * below). Tasks have no review_due_at.
   *
   * This is the ONLY writer of the `review` label in the MVP. The server runs it
   * on a nightly timer across all brains (packages/server review-sweep). Returns
   * the count of newly-stamped engrams.
   */
  stampDueReviewLabels(now: string = new Date().toISOString()): number {
    // datetime() normalizes BOTH the stored value and the cutoff, so the compare
    // is correct across formats — v0.8 backfilled review_due_at as SQLite
    // 'YYYY-MM-DD HH:MM:SS' while app writes are ISO-8601 '…T…Z'; a raw lexical
    // `<` diverges on same-day values (space 0x20 < 'T' 0x54).
    const typePlaceholders = REVIEWABLE_TYPES.map(() => '?').join(', ')
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO engram_labels (engram_id, label_id)
      SELECT c.id, ? FROM engrams c
      WHERE c.type IN (${typePlaceholders})
        AND c.status = 'active'
        AND json_extract(c.properties, '$.review_due_at') IS NOT NULL
        AND datetime(json_extract(c.properties, '$.review_due_at')) < datetime(?)
        AND NOT EXISTS (
          SELECT 1 FROM engram_labels el
          WHERE el.engram_id = c.id AND el.label_id = ?
        )
    `).run(REVIEW_LABEL, ...REVIEWABLE_TYPES, now, REVIEW_LABEL)

    // v0.15: open tasks by INACTIVITY — last movement (the later of updated_at
    // and the newest entry) older than TASK_INACTIVITY_DAYS. Covers legacy tasks
    // without touching them; any movement strips the label again.
    const openPlaceholders = TASK_OPEN_STATUSES.map(() => '?').join(', ')
    const tasks = this.db.prepare(`
      INSERT OR IGNORE INTO engram_labels (engram_id, label_id)
      SELECT c.id, ? FROM engrams c
      WHERE c.type = 'task'
        AND c.status IN (${openPlaceholders})
        AND MAX(
          datetime(c.updated_at),
          COALESCE(datetime((SELECT MAX(te.at) FROM task_entries te WHERE te.task_id = c.id)), datetime(c.updated_at))
        ) < datetime(?, ?)
        AND NOT EXISTS (
          SELECT 1 FROM engram_labels el
          WHERE el.engram_id = c.id AND el.label_id = ?
        )
    `).run(REVIEW_LABEL, ...TASK_OPEN_STATUSES, now, `-${TASK_INACTIVITY_DAYS} days`, REVIEW_LABEL)
    return res.changes + tasks.changes
  }

  /**
   * v0.13: remove the `review` label from an engram — the explicit clear-path the
   * add-only sweep deliberately does NOT do. Called when a review is resolved
   * (confirmReview pushes review_due_at forward) or the engram leaves 'active'
   * (supersede/invalidate — a dead engram needs no review). Idempotent.
   */
  private stripReviewLabel(id: string): void {
    this.db.prepare(
      `DELETE FROM engram_labels WHERE engram_id = ? AND label_id = ?`
    ).run(id, REVIEW_LABEL)
  }

  query(q: EngramQuery): Engram[] {
    const conditions: string[] = []
    const params: any[] = []

    // v0.9.1 Cluster 1: namespaces filter removed entirely — 1 user = 1 brain.

    if (q.scope) {
      conditions.push('c.scope = ?')
      params.push(q.scope)
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
    if (q.label) {
      // v0.13.x: membership filter on the labels axis (e.g. `review`) — the
      // cockpit's pending-reviews queue and badge read this instead of paging
      // /list and filtering labels client-side.
      conditions.push('c.id IN (SELECT engram_id FROM engram_labels WHERE label_id = ?)')
      params.push(slugifyLabel(q.label))
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
      this.hydrateFacets(ranked.map(x => x.engram))
      return bucketByRelevance(ranked, e => this.score(e), BM25_RELEVANCE_EPS)
    }

    let engrams = rows.map(r => this.rowToEngram(r))
    this.hydrateFacets(engrams)

    // Post-query: score-based sorting (significance × recency) — the no-search
    // score path (e.g. recall with an empty query) keeps the original behaviour.
    if (q.order_by === 'score') {
      engrams.sort((a, b) => this.score(b) - this.score(a))
    }

    return engrams
  }

  /**
   * v0.9.1 Cluster 1: callerNamespace param is gone. Simple WHERE id = ?.
   */
  update(
    id: string,
    partial: Partial<EngramInput> & { status?: string }
  ): StoredEngram | null {
    const existing = this.db.prepare(
      'SELECT * FROM engrams WHERE id = ?'
    ).get(id) as any
    if (!existing) return null
    let wikilinks: { resolved: string[]; unresolved: string[] } = { resolved: [], unresolved: [] }

    // Event immutability: events may only change significance + status,
    // NOT content/properties/type/scope/title.
    if (existing.type === 'event') {
      const forbidden = ['content', 'properties', 'type', 'scope', 'title'] as const
      const violations = forbidden.filter(field => (partial as Record<string, unknown>)[field] !== undefined)
      if (violations.length > 0) {
        throw new Error(
          `Cannot modify event fields: ${violations.join(', ')}. ` +
          `Events are immutable. Only significance and status are mutable.`
        )
      }
    }

    // v0.6: Re-validation when type/properties/status change
    // v0.10.3: properties now uses shallow-merge semantics (incoming wins,
    // null deletes a key); was full-replace previously.
    const newType = (partial.type ?? existing.type) as any
    let newProps: Record<string, unknown> | null = existing.properties
      ? JSON.parse(existing.properties)
      : null
    if (partial.properties !== undefined) {
      const base = (newProps ?? {}) as Record<string, unknown>
      const merged: Record<string, unknown> = { ...base, ...partial.properties }
      for (const k of Object.keys(merged)) {
        if (merged[k] === null) delete merged[k]
      }
      newProps = merged
    }
    const newStatus = (partial.status ?? existing.status) as any
    if (partial.type || partial.properties !== undefined || partial.status !== undefined) {
      // create=false: legacy decisions without alternatives stay patchable (v0.15);
      // prevStatus lets transition-only checks tell a status change from a re-save.
      if (partial.type !== undefined) validateEngramType(partial.type)
      validateProperties(newType, newProps as Record<string, unknown>, newStatus, {
        create: false,
        prevStatus: existing.status,
      })
    }

    // The rule/profile format, only when the update touches what it governs:
    // status-only and review changes keep legacy entries patchable.
    const oldProps = existing.properties ? JSON.parse(existing.properties) : {}
    const formatTouched = (partial.type !== undefined && partial.type !== existing.type)
      || (partial.content !== undefined && partial.content !== existing.content)
      || newProps?.trigger !== oldProps.trigger
      || newProps?.applies !== oldProps.applies
    if (formatTouched) validateFormat(newType, partial.content ?? existing.content, newProps)

    // v0.15: task lifecycle rules that need the stored state.
    const isTask = newType === 'task'
    const statusChanged = partial.status !== undefined && partial.status !== existing.status
    if (isTask) {
      // Stage is frozen once a task is closed: it shows where the task ended.
      const wasOpen = (TASK_OPEN_STATUSES as readonly string[]).includes(existing.status)
      const staysClosed = !wasOpen && !(TASK_OPEN_STATUSES as readonly string[]).includes(newStatus)
      const oldStage = existing.properties ? JSON.parse(existing.properties).stage : undefined
      if (staysClosed && (newProps?.stage ?? undefined) !== oldStage) {
        throw new Error('Invalid engram: stage is frozen once a task is closed.')
      }
      // A parent cannot be resolved while a sub-task is open.
      if (statusChanged && partial.status === 'resolved') {
        const open = this.openSubtasksOf(id)
        if (open.length > 0) {
          throw new Error(
            `Invalid engram: task ${id} has open sub-tasks: ` +
            open.map(c => `${c.id} ${c.title ?? '(no title)'}`).join(', '),
          )
        }
      }
    }

    // v0.10.4: reject tool-call template leak in patched content
    if (partial.content !== undefined) {
      validateNoTemplateLeak(partial.content)
    }

    // v0.8 C3: hard scope validation on a scope change
    if (partial.scope !== undefined && partial.scope !== existing.scope) {
      this.validateScope(partial.scope)
    }

    // v0.12: normalize + validate tags against the registry before any write (unknown → reject)
    const tagSlugs = partial.tags !== undefined ? this.normalizeAndValidateTags(partial.tags) : undefined
    // v0.14: same for subjects
    const subjectSlugs = partial.subjects !== undefined ? this.normalizeAndValidateSubjects(partial.subjects) : undefined

    const fields: string[] = []
    const params: any[] = []

    if (partial.content !== undefined) { fields.push('content = ?'); params.push(partial.content) }
    if (partial.type !== undefined) {
      fields.push('type = ?'); params.push(partial.type)
    }
    if (partial.scope !== undefined) { fields.push('scope = ?'); params.push(partial.scope) }
    if (partial.title !== undefined) { fields.push('title = ?'); params.push(partial.title) }
    if (partial.status !== undefined) { fields.push('status = ?'); params.push(partial.status) }
    if (partial.significance !== undefined) { fields.push('significance = ?'); params.push(partial.significance) }
    if (partial.properties !== undefined) { fields.push('properties = ?'); params.push(JSON.stringify(newProps)) }

    // v0.12: a tags-only update has no column fields but must still run — so the
    // early-return fires only when NEITHER columns NOR tags changed.
    const hasTagUpdate = partial.tags !== undefined
    const hasSubjectUpdate = partial.subjects !== undefined
    if (fields.length === 0 && !hasTagUpdate && !hasSubjectUpdate) return this.getRaw(id)

    // v0.12: a tags-only change is still a modification — bump updated_at so it
    // resurfaces in updated_at-ordered views (timeline, list default) and any
    // change-watermark consumer sees it.
    if (fields.length > 0 || hasTagUpdate || hasSubjectUpdate) {
      fields.push("updated_at = datetime('now')")
      params.push(id)
    }

    // v0.10.10 L1: row-UPDATE + FTS re-sync atomic — a failed FTS re-index must
    // not leave the engram row updated but its search index stale. v0.12: the tag
    // replace joins the same transaction.
    this.db.transaction(() => {
      if (fields.length > 0) {
        this.db.prepare(
          `UPDATE engrams SET ${fields.join(', ')} WHERE id = ?`
        ).run(...params)

        // Update FTS if content/scope/title changed
        if (partial.content !== undefined || partial.scope !== undefined || partial.title !== undefined) {
          this.db.prepare('DELETE FROM engrams_fts WHERE id = ?').run(id)
          this.db.prepare(`
            INSERT INTO engrams_fts (id, content, scope, title)
            SELECT id, content, scope, COALESCE(title, '') FROM engrams WHERE id = ?
          `).run(id)
        }
      }

      // v0.12: full-set replace of tag memberships (normalized + validated above)
      if (hasTagUpdate) this.replaceEngramTags(id, tagSlugs!)
      // v0.14: full-set replace of subject memberships (normalized + validated above)
      if (hasSubjectUpdate) this.replaceEngramSubjects(id, subjectSlugs!)
      // v0.14 Cluster C: re-materialize [[wikilinks]] when content changed (add-only)
      if (partial.content !== undefined) wikilinks = this.materializeWikilinks(id, partial.content, partial.scope ?? existing.scope)
      // v0.15: invalidating a parent task invalidates its open sub-tasks (recursive).
      if (isTask && statusChanged && partial.status === 'invalidated') this.cascadeInvalidate(id)
    })()

    if (wikilinks.unresolved.length > 0) {
      console.warn(`[EML] unresolved wikilink(s) in engram ${id}: ${wikilinks.unresolved.map(t => `[[${t}]]`).join(' ')}`)
    }

    // v0.13: a status transition off 'active' (supersede/invalidate/resolved/
    // expired) means the engram no longer needs review — clear any `review` label
    // the sweep stamped. Add-only sweep never does this itself.
    // v0.15: for a task ANY movement clears it (the label means "no movement").
    if (isTask || (partial.status !== undefined && newStatus !== 'active')) this.stripReviewLabel(id)

    const updated = this.getRaw(id)
    if (!updated) return updated
    // v0.15: superseding a parent task does not cascade — list its open sub-tasks.
    const openSubtasks = isTask && statusChanged && partial.status === 'superseded' ? this.openSubtasksOf(id) : []
    return {
      ...updated,
      ...(wikilinks.unresolved.length > 0 ? { unresolved_links: wikilinks.unresolved } : {}),
      ...(openSubtasks.length > 0 ? { open_subtasks: openSubtasks } : {}),
    }
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

  /**
   * v0.8 C9: brain hygiene — review confirmation.
   * v0.9.1 Cluster 1: callerNamespace param is gone.
   */
  confirmReview(id: string): Engram | null {
    const existing = this.db.prepare(
      'SELECT * FROM engrams WHERE id = ?'
    ).get(id) as any
    if (!existing) return null

    // v0.15: a task is flagged for inactivity, not by a due date — confirming it
    // ("still relevant") counts as a movement: bump updated_at, clear the label.
    // It comes back after another TASK_INACTIVITY_DAYS without movement.
    if (existing.type === 'task') {
      this.db.prepare(`UPDATE engrams SET updated_at = datetime('now') WHERE id = ?`).run(id)
      this.stripReviewLabel(id)
      return this.getRaw(id)
    }

    const reviewDays = TYPE_REVIEW_DEFAULTS[existing.type as keyof typeof TYPE_REVIEW_DEFAULTS]
    if (reviewDays === undefined) {
      throw new Error(
        `confirmReview is only supported for decision/rule/profile/task (got ${existing.type}).`
      )
    }

    const props = existing.properties ? JSON.parse(existing.properties) : {}
    props.review_due_at = new Date(Date.now() + reviewDays * 86400_000).toISOString()
    this.db.prepare(`
      UPDATE engrams SET properties = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(props), id)

    // v0.13: confirming a review pushes review_due_at into the future, so the
    // engram is no longer due — clear the `review` label the sweep had stamped.
    this.stripReviewLabel(id)

    return this.getRaw(id)
  }

  /** Returns true if a new edge was inserted, false if it already existed (idempotent). */
  relate(input: RelationInput): boolean {
    // v0.15: part_of has rules beyond the verb (tasks only, acyclic, one parent).
    if (input.relation === 'part_of') {
      this.assertPartOf(input.source_id, input.target_id)
    }
    // v0.9 Cluster 1: ON CONFLICT on (source_id, target_id, relation) — no namespace anymore.
    const info = this.db.prepare(`
      INSERT INTO relations (id, source_id, target_id,
        relation, detection_method, strength, explanation, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(source_id, target_id, relation) DO NOTHING
    `).run(
      uuid(),
      input.source_id, input.target_id,
      input.relation, input.detection_method,
      input.strength ?? 1.0,
      input.explanation ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    )
    if (input.relation !== 'related_to') this.dropWikilinkEcho(input.source_id, input.target_id)
    return info.changes > 0
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
   *   - open_tasks: planned/active tasks in the scope, sorted by priority + due_date (limit 10)
   *   - recent_decisions: top 5 decisions by significance + created_at DESC
   *   - recent_logs: top 3 logs by created_at DESC
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

    const open_tasks = this.queryEngramsRaw(OPEN_TASKS_IN_SCOPE_SQL, [scope])

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
      ORDER BY created_at DESC LIMIT 2
    `, [scope])

    // v0.10.5: active rules in scope — name-only in the dashboard render. (relations
    // dropped from the dashboard: noise for orientation, reachable via eml_get --with-relations.)
    const rules = this.queryEngramsRaw(`
      SELECT * FROM engrams
      WHERE scope = ? AND type = 'rule' AND status = 'active'
      ORDER BY created_at DESC LIMIT 15
    `, [scope])

    // v0.13: active decision/rule/profile in scope carrying the `review` label —
    // the staleness queue. Kept SEPARATE from open_tasks so it never pollutes the
    // real todo list. Intersect status='active' as a safety net (the sweep is
    // add-only + strips on transition, but this guards a lingering row).
    // v0.15: + open tasks flagged for inactivity (planned counts as open too).
    const pending_reviews = this.queryEngramsRaw(`
      SELECT c.* FROM engrams c
      JOIN engram_labels el ON el.engram_id = c.id AND el.label_id = ?
      WHERE c.scope = ? AND (c.status = 'active' OR (c.type = 'task' AND c.status = 'planned'))
      ORDER BY datetime(json_extract(c.properties, '$.review_due_at')) ASC
      LIMIT 15
    `, [REVIEW_LABEL, scope])

    return { scope, current_status, open_tasks, recent_decisions, recent_logs, rules, pending_reviews }
  }

  // === Private ===

  private queryEngramsRaw(sql: string, params: any[]): Engram[] {
    const engrams = (this.db.prepare(sql).all(...params) as any[]).map(r => this.rowToEngram(r))
    this.hydrateFacets(engrams)
    return engrams
  }

  private rowToRelation(row: any): Relation {
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

  private getRaw(id: string): Engram | null {
    const row = this.db.prepare(
      'SELECT * FROM engrams WHERE id = ?'
    ).get(id) as any
    if (!row) return null
    const engram = this.rowToEngram(row)
    this.hydrateFacets([engram])
    return engram
  }

  private score(engram: Engram): number {
    // v0.8 C7: no decay_factor on the engram anymore (decay mechanism not activated).
    const sig = significanceWeight(engram.significance)
    const recency = recencyBoost(engram.created_at)
    return sig * recency
  }

  private rowToEngram(row: any): Engram {
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
      // v0.12/v0.13: tags AND labels are batch-hydrated at the read boundary
      // (hydrateFacets) so the row mapper stays pure — no per-row query. Default
      // [] until hydrated.
      tags: [],
      labels: [],
      subjects: [],
    }
  }

  private rowToRelationWithTarget(row: any): RelationWithTarget {
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
