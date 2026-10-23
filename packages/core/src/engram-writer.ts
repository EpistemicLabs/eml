import {
  Engram, EngramInput, RelationInput,
  TYPE_DEFAULT_STATUS, TYPE_REVIEW_DEFAULTS,
  EngramType, ConflictCandidate, StoredEngram, DetectionMethod,
  EngramStatus, OpenSubtask, BoundItem,
  TASK_OPEN_STATUSES, TASK_LINK_RELATION,
} from './types'
import { validateEngramType, validateFormat, validateScopePattern, validateScopeExists, validateNoTemplateLeak } from './validate'
import { TYPE_FIELDS, ORIGINS, SEED_ORIGIN, validateFields, normalizeTimestampFields, fieldProblem, unknownFieldsError, isBlank } from './fields'
import {
  appendEntry, bumpRev, EVIDENCE_SOURCES, EVIDENCE_STANCES,
  type Entry, type EntryInput, type EvidenceSource, type EvidenceStance,
} from './entries'
import { learningState, LEARNING_SHARPENED } from './learning'
import { slugifyTag } from './tags'
import { type Stamp, addDays } from './env'
import { REVIEWABLE_TYPES } from './review-due'
import { slugifySubject } from './subjects'

import { EngramStore, renderLogContent, hasStartHere, CONFLICT_TYPES, CONFLICT_CANDIDATE_LIMIT, CONFLICT_COVERAGE_THRESHOLD, CONFLICT_MAX, CONFLICT_MIN_SHARED_TERMS, EVENT_DUPLICATE_WINDOW_MS, CLOSED_WITH_TASK, STORE_INPUT_KEYS, createInputKeys, TRACK_TASK_KEYS, UPDATE_PATCH_KEYS, LEARN_KEYS, LEARNING_CONTENT_MAX_CHARS, extractSalientTerms, termCoverage, extractWikilinkTargets, type TrackTaskInput, type EngramPatch, type LearnInput, type LearnResult } from './engrams'

/**
 * v0.20: the write half of the engram store — internal to core. Only the
 * command modules (commands/) call it, inside apply()'s transaction, with the
 * write's one Stamp. EML exposes the read half (EngramStore) and apply().
 */
export class EngramWriter extends EngramStore {
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

  /**
   * v0.19: create an engram of any type except learning (createLearning) — the one
   * write path for MCP, REST and CLI. Strict: the input may carry only the
   * universal fields and the type's own fields (fields.ts); every rule of the
   * type is checked here, so no surface can skip it. Provenance comes from the
   * env's actor. Errors start with `Invalid engram:`.
   */
  store(input: EngramInput, stamp: Stamp): StoredEngram {
    const actor = stamp.actor
    validateEngramType(input.type)
    const type = input.type
    if (type === 'learning') {
      throw new Error('Invalid engram: a learning is written with eml_learning, which checks the topic first.')
    }
    const unknownInput = Object.keys(input).filter(k => !STORE_INPUT_KEYS.has(k) && (input as unknown as Record<string, unknown>)[k] !== undefined)
    if (unknownInput.length > 0) throw unknownFieldsError(type, unknownInput, createInputKeys(type))
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input.properties ?? {})) if (v !== null && v !== undefined) props[k] = v
    // A default-brain seed rule has no agreement yet: getting-started asks the
    // user and sets agreed with their words (decision v0.19-seed-rules-agreement).
    validateFields(type, props, 'create', type === 'rule' && input.origin === SEED_ORIGIN ? ['agreed'] : [])
    normalizeTimestampFields(props)

    // --- universal rules ---
    if (type !== 'log' && isBlank(input.content)) throw new Error('Invalid engram: content must not be empty.')
    validateNoTemplateLeak(input.content)
    if (type === 'status') {
      if (input.title !== undefined) {
        throw new Error('Invalid engram: a status has no title — a scope has one status, its history is the supersedes chain.')
      }
    } else if (isBlank(input.title) && !(type === 'note' && input.origin)) {
      throw new Error(`Invalid engram: ${type === 'event' || type === 'log' ? 'an' : 'a'} ${type} needs a title (kebab-case recall anchor).`)
    }
    let status: EngramStatus = TYPE_DEFAULT_STATUS[type]
    if (input.status !== undefined) {
      if (type !== 'task') throw new Error(`Invalid engram: status is not set on create — a new ${type} is active.`)
      if (input.status !== 'planned' && input.status !== 'active') {
        throw new Error('Invalid engram: a task is created planned or active — done things are not tasks (record them as an event or in the log).')
      }
      status = input.status
    }
    if (input.origin !== undefined && !(ORIGINS as readonly string[]).includes(input.origin)) {
      throw new Error(`Invalid engram: origin must be one of ${ORIGINS.join(', ')}.`)
    }
    if (input.app !== undefined) {
      if (!input.origin) throw new Error('Invalid engram: app state needs an origin (the software it belongs to).')
      const p = fieldProblem('app', { kind: 'map' }, input.app)
      if (p) throw new Error(`Invalid engram: ${p}`)
    }

    // --- type rules ---
    if (type === 'task' && props.outcome !== undefined) {
      throw new Error('Invalid engram: outcome is set when the task closes (eml_track_task), not on create.')
    }
    if (input.parent_id !== undefined && type !== 'task') throw new Error('Invalid engram: part_of needs two tasks.')
    const taskLink = input.task_id !== undefined ? TASK_LINK_RELATION[type] : undefined
    if (input.task_id !== undefined) {
      if (!taskLink) throw new Error(`Invalid engram: task_id is not available for type ${type}.`)
      const target = this.db.prepare('SELECT type FROM engrams WHERE id = ?').get(input.task_id) as { type: string } | undefined
      if (target?.type !== 'task') throw new Error(`Invalid engram: task_id ${input.task_id} is not a task.`)
    }
    if (type === 'decision' || type === 'note') {
      if (input.task_id !== undefined && props.binding === undefined) {
        throw new Error(
          `Invalid engram: a ${type} with task_id needs binding — standing if it still holds once the task is done, ` +
          'task if it only governs how this task is done (it closes with the task).',
        )
      }
      if (input.task_id === undefined && props.binding === 'task') {
        throw new Error(`Invalid engram: binding task needs task_id — without a task a ${type} is standing.`)
      }
      if (props.binding === 'task') this.assertTaskOpenForBinding(input.task_id!, type)
    }
    if (type === 'profile' && !/^(agent|user|entity)\./.test(input.scope)) {
      throw new Error('Invalid engram: a profile is about someone — scope agent.<id>, user.<id> or entity.<id>.')
    }
    if (input.from_learning !== undefined && type !== 'rule') {
      throw new Error('Invalid engram: from_learning is only for a rule that grows from learnings.')
    }
    const fromLearning = input.from_learning ?? []
    for (const lid of fromLearning) {
      const l = this.db.prepare('SELECT type, status FROM engrams WHERE id = ?').get(lid) as { type: string, status: string } | undefined
      if (l?.type !== 'learning') throw new Error(`Invalid engram: from_learning ${lid} is not a learning.`)
      if (l.status !== 'active') throw new Error(`Invalid engram: learning ${lid} is ${l.status}, not active.`)
    }
    const supersedePlan = this.planSupersedes([...new Set(input.supersedes ?? [])], { id: null, type, status, parentId: input.parent_id })

    // Rules and profiles in the short format (validate.ts).
    validateFormat(type, input.content, props)

    // review_due_at default for decision / rule / profile
    const reviewDays = TYPE_REVIEW_DEFAULTS[type]
    if (reviewDays !== undefined && props.review_due_at === undefined) {
      props.review_due_at = addDays(stamp.at, reviewDays)
    }

    // A log is one per session; its START HERE block is rendered from the fields.
    let content = input.content
    if (type === 'log') {
      const existing = this.sessionLog(actor.session_id)
      if (existing) {
        throw new Error(
          `Invalid engram: this session already has a log (${existing.id} ${existing.title ?? ''}) — update it with eml_update.`.replace(' )', ')'),
        )
      }
      content = renderLogContent(props, input.content ?? '')
    }

    this.validateScope(input.scope)
    const tagSlugs = input.tags !== undefined ? this.normalizeAndValidateTags(input.tags) : undefined
    const subjectSlugs = input.subjects !== undefined ? this.normalizeAndValidateSubjects(input.subjects) : undefined

    const id = stamp.newId()
    const now = stamp.at
    let wikilinks: { resolved: string[]; unresolved: string[] } = { resolved: [], unresolved: [] }
    const openSubtasks: OpenSubtask[] = []
    const superseded: string[] = []
    let previousState: string | null | undefined

    // One transaction: the row, its search entry, every edge and entry it draws.
    // ingested_by is the caller the server derived from the token — never input.
    this.db.transaction(() => {
      // One core profile per scope (unique index): the old one goes first.
      stamp.created.add(id)
      if (type === 'profile' && props.core === true) superseded.push(...this.autoSupersedeCoreProfile(id, input.scope, stamp))
      this.db.prepare(`
        INSERT INTO engrams (
          id, content, type, scope, title, status, significance, properties,
          origin, ingested_by, ingestion_method, session_id, model, harness,
          created_at, updated_at, rev
        ) VALUES (?, ?, ?, ?, ?, ?, 'normal', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        id, content, type, input.scope, input.title ?? null, status,
        JSON.stringify(input.app ? { ...props, app: input.app } : props),
        input.origin ?? null, actor.handle, actor.ingestion_method,
        actor.session_id, actor.model, actor.harness,
        now, now,
      )
      this.db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) VALUES (?, ?, ?, ?)`)
        .run(id, content, input.scope, input.title ?? '')

      if (type === 'status') {
        previousState = this.activeStatusState(input.scope, id)
        superseded.push(...this.autoSupersedeStatusEngrams(id, input.scope, stamp))
      }
      if (type === 'task') {
        const stage = typeof props.stage === 'string' ? ` · stage ${props.stage}` : ''
        appendEntry(this.db, id, { kind: 'change', text: `created (${status}${stage})`, stage: (props.stage as string) ?? null }, stamp)
      }

      const replaced = this.applySupersedes(id, supersedePlan, stamp)
      superseded.push(...replaced.superseded)
      openSubtasks.push(...replaced.openSubtasks)
      for (const lid of fromLearning) {
        this.supersede(id, lid, stamp)
        superseded.push(lid)
      }

      if (input.parent_id !== undefined) this.linkPartOf(id, input.parent_id, stamp)

      // A task-linked write: edge to the task + a change entry in its journal.
      if (input.task_id !== undefined && taskLink) {
        this.db.prepare(`
          INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, created_at)
          VALUES (?, ?, ?, ?, 'agent_declared', 1.0, ?)
          ON CONFLICT(source_id, target_id, relation) DO NOTHING
        `).run(stamp.newId(), id, input.task_id, taskLink, stamp.at)
        const label = input.title ?? (input.content.length > 80 ? `${input.content.slice(0, 80)}…` : input.content)
        const verb = type === 'decision' ? 'taken' : type === 'event' ? 'recorded' : 'written'
        this.appendTaskChange(input.task_id, `${type} ${verb}: ${label} (${id})`, stamp)
      }

      if (tagSlugs && tagSlugs.length > 0) this.insertEngramTags(id, tagSlugs, stamp)
      if (subjectSlugs && subjectSlugs.length > 0) this.insertEngramSubjects(id, subjectSlugs, stamp)
      wikilinks = this.materializeWikilinks(id, content, input.scope, stamp)
    })()

    if (wikilinks.unresolved.length > 0) {
      console.warn(`[EML] unresolved wikilink(s) in engram ${id}: ${wikilinks.unresolved.map(t => `[[${t}]]`).join(' ')}`)
    }

    const stored = this.getRaw(id, stamp.at)!
    const extra: Partial<StoredEngram> = {}
    if (wikilinks.unresolved.length > 0) extra.unresolved_links = wikilinks.unresolved
    if (openSubtasks.length > 0) extra.open_subtasks = openSubtasks
    if (superseded.length > 0) extra.superseded = superseded
    if (type === 'status') {
      extra.previous_state = previousState ?? null
      const tracks = this.statusTracksOf(input.scope)
      if (tracks.hasObject) {
        extra.status_tracks = tracks.value
        if (tracks.value === null) extra.status_tracks_missing = true
      }
    }
    if (CONFLICT_TYPES.has(type)) {
      const potential_conflicts = this.findPotentialConflicts(stored, stamp.at)
      if (potential_conflicts.length > 0) extra.potential_conflicts = potential_conflicts
    }
    return { ...stored, ...extra }
  }

  /**
   * The supersede rules, one check for every write path (decision
   * supersede-rules): only a live engram (active, an open task) supersedes; an
   * engram has one successor and the chain has no loop; the type table
   * (assertSupersedeTypes); a task does not replace a task of its own part_of
   * line. Per target it returns 'replace' — the target is open (active, a
   * planned task) and is set to superseded — or 'edge' — the target is closed
   * already and keeps its status, the call only records its successor.
   * `next.id` is null on create; `next.parentId` is the parent the call sets
   * (create or track_task), undefined keeps the current one.
   */
  private planSupersedes(oldIds: readonly string[], next: { id: string | null, type: EngramType, status: string, parentId?: string | null }): Map<string, 'replace' | 'edge'> {
    const plan = new Map<string, 'replace' | 'edge'>()
    if (oldIds.length === 0) return plan
    if (next.type === 'status') throw new Error('Invalid engram: a status supersedes the previous one by itself — no supersedes.')
    if (next.type === 'event' || next.type === 'log') throw new Error(`Invalid engram: ${next.type === 'event' ? 'an event' : 'a log'} does not supersede — no supersedes.`)
    if (!(next.type === 'task' ? (TASK_OPEN_STATUSES as readonly string[]).includes(next.status) : next.status === 'active')) {
      throw new Error(next.type === 'task'
        ? 'Invalid engram: only an open task replaces another — reopen this one first, or close the old task with eml_track_task.'
        : `Invalid engram: ${next.id} is ${next.status} — only an active engram supersedes another; reactivate it first (status=active) or write a new one.`)
    }
    const parentLine = next.parentId === null ? [] : next.parentId !== undefined ? [next.parentId, ...this.ancestorsOf(next.parentId)] : next.id ? this.ancestorsOf(next.id) : []
    for (const oldId of oldIds) {
      if (oldId === next.id) throw new Error('Invalid engram: an engram cannot supersede itself.')
      const old = this.db.prepare('SELECT type, status FROM engrams WHERE id = ?').get(oldId) as { type: string, status: string } | undefined
      if (!old) throw new Error(`Invalid engram: supersedes ${oldId} — no such engram.`)
      // one successor that holds: an invalidated one (an undone supersede) is history
      const by = this.liveSuccessorOf(oldId)
      if (by) throw new Error(`Invalid engram: ${oldId} is already superseded by ${by} — continue on that one.`)
      if (next.id && this.isOlderThan(next.id, oldId)) {
        throw new Error(`Invalid engram: ${next.id} is already in the supersedes chain of ${oldId} — superseding it would close a loop.`)
      }
      if (parentLine.includes(oldId)) {
        throw new Error(`Invalid engram: ${oldId} is a parent of this task — a sub-task does not replace its parent; close the parent with eml_track_task.`)
      }
      if (next.id && this.ancestorsOf(oldId).includes(next.id)) {
        throw new Error(`Invalid engram: ${oldId} is a sub-task of this task — a task does not replace its own sub-task; close it with eml_track_task.`)
      }
      this.assertSupersedeTypes(oldId, old.type, next.type)
      plan.set(oldId, old.status === 'active' || old.status === 'planned' ? 'replace' : 'edge')
    }
    return plan
  }

  /** Which type replaces which: a status, event or log never by hand, a task only by a task, a learning only a rule or learning. */
  private assertSupersedeTypes(oldId: string, oldType: string, newType: EngramType): void {
    if (oldType === 'event') throw new Error(`Invalid engram: ${oldId} is an event — an event is corrected, never superseded.`)
    if (oldType === 'log') throw new Error(`Invalid engram: ${oldId} is a log — a log is corrected with eml_update, never superseded.`)
    if (oldType === 'status') {
      throw new Error(`Invalid engram: ${oldId} is a status — a status is superseded by the next eml_set_status in its scope.`)
    }
    if (oldType === 'task' && newType !== 'task') {
      throw new Error(`Invalid engram: ${oldId} is a task — a task is replaced by a task (eml_create_task(supersedes=[id]) or eml_track_task(<new task id>, supersedes=[id])) or closed with eml_track_task.`)
    }
    if (newType === 'task' && oldType !== 'task') {
      throw new Error(`Invalid engram: supersedes ${oldId} is a ${oldType} — a task replaces a task; a ${oldType} is superseded by eml_update(<new id>, supersedes=[…]) on its successor.`)
    }
    if (newType === 'learning' && oldType !== 'rule' && oldType !== 'learning') {
      throw new Error('Invalid engram: a learning supersedes only a rule (demoted on the user\'s word) or another learning.')
    }
  }

  /** True if `id` is already superseded, directly or down the chain, by `newer`. */
  private isOlderThan(id: string, newer: string): boolean {
    return !!this.db.prepare(`
      WITH RECURSIVE older(id) AS (
        SELECT target_id FROM relations WHERE source_id = ? AND relation = 'supersedes'
        UNION SELECT r.target_id FROM relations r JOIN older o ON r.source_id = o.id WHERE r.relation = 'supersedes'
      ) SELECT 1 FROM older WHERE id = ?
    `).get(newer, id)
  }

  /** The parent, grandparent, … of a task (part_of upwards). */
  private ancestorsOf(id: string): string[] {
    return (this.db.prepare(`
      WITH RECURSIVE up(id) AS (
        SELECT target_id FROM relations WHERE source_id = ? AND relation = 'part_of'
        UNION SELECT r.target_id FROM relations r JOIN up u ON r.source_id = u.id WHERE r.relation = 'part_of'
      ) SELECT id FROM up
    `).all(id) as Array<{ id: string }>).map(r => r.id)
  }

  /** The engram that superseded this one (its supersedes edge), if any. */
  private successorOf(id: string): string | undefined {
    return (this.db.prepare(`SELECT source_id FROM relations WHERE target_id = ? AND relation = 'supersedes' ORDER BY created_at ASC LIMIT 1`).get(id) as { source_id: string } | undefined)?.source_id
  }

  /**
   * Carry out a plan of planSupersedes inside the caller's transaction. An
   * open task replaced by a task hands over its bound items and reports its
   * open sub-tasks; a closed target only gets the edge. Journal entries on
   * the tasks of both sides.
   */
  private applySupersedes(newId: string, plan: Map<string, 'replace' | 'edge'>, stamp: Stamp): { superseded: string[], openSubtasks: OpenSubtask[] } {
    const typeOf = (id: string) => (this.db.prepare('SELECT type FROM engrams WHERE id = ?').get(id) as { type: string }).type
    const newIsTask = typeOf(newId) === 'task'
    const openSubtasks: OpenSubtask[] = []
    for (const [oldId, mode] of plan) {
      const oldIsTask = typeOf(oldId) === 'task'
      if (mode === 'replace') this.supersede(newId, oldId, stamp)
      else {
        this.linkSupersede(newId, oldId, 'agent_declared', stamp)
        if (oldIsTask) this.appendTaskChange(oldId, `superseded by ${newId}`, stamp)
      }
      if (newIsTask) this.appendTaskChange(newId, `supersedes ${oldId}`, stamp)
      if (mode === 'replace' && oldIsTask) {
        this.moveBoundItems(oldId, newId, stamp)
        openSubtasks.push(...this.openSubtasksOf(oldId))
      }
    }
    return { superseded: [...plan.keys()], openSubtasks }
  }

  /** Supersede one engram by another: status flip + edge. Inside the caller's transaction. */
  private supersede(newId: string, oldId: string, stamp: Stamp): void {
    this.linkSupersede(newId, oldId, 'agent_declared', stamp)
    if ((this.db.prepare('SELECT type FROM engrams WHERE id = ?').get(oldId) as { type: string }).type === 'task') {
      this.appendTaskChange(oldId, `superseded by ${newId}`, stamp)
    }
  }

  /** A task-bound decision or note needs a task that is still open. */
  /** The task a decision or note is tied to (task_id at creation: a refines / derived_from edge). */
  private boundTaskOf(id: string): { id: string, status: string } | undefined {
    return this.db.prepare(`SELECT t.id, t.status FROM relations r JOIN engrams t ON t.id = r.target_id WHERE r.source_id = ? AND t.type = 'task' AND r.relation IN ('derived_from', 'refines') ORDER BY r.created_at ASC, r.rowid ASC LIMIT 1`).get(id) as { id: string, status: string } | undefined
  }

  private assertTaskOpenForBinding(taskId: string, type: string): void {
    const t = this.db.prepare('SELECT status FROM engrams WHERE id = ?').get(taskId) as { status: string } | undefined
    if (t && !(TASK_OPEN_STATUSES as readonly string[]).includes(t.status)) {
      throw new Error(`Invalid engram: task ${taskId} is ${t.status} — a ${type} bound to it would close with it; use binding standing, or reopen the task first.`)
    }
  }

  /** The state of the scope's active status before `exceptId` was written. */
  private activeStatusState(scope: string, exceptId: string): string | null {
    const row = this.db.prepare(
      `SELECT properties FROM engrams WHERE scope = ? AND type = 'status' AND status = 'active' AND id != ? ORDER BY updated_at DESC LIMIT 1`,
    ).get(scope, exceptId) as { properties: string | null } | undefined
    if (!row) return null
    const p = row.properties ? JSON.parse(row.properties) : {}
    return typeof p.state === 'string' ? p.state : null
  }

  /** The scope's active core profile other than `exceptId`, if any. */
  private activeCoreProfileIn(scope: string, exceptId: string): string | null {
    const row = this.db.prepare(`
      SELECT id FROM engrams
      WHERE scope = ? AND type = 'profile' AND status = 'active' AND id != ?
        AND json_extract(properties, '$.core') = 1
    `).get(scope, exceptId) as { id: string } | undefined
    return row?.id ?? null
  }

  /** A new core profile supersedes the scope's previous one (one core per scope). */
  private autoSupersedeCoreProfile(newId: string, scope: string, stamp: Stamp): string[] {
    const rows = this.db.prepare(`
      SELECT id FROM engrams
      WHERE scope = ? AND type = 'profile' AND status = 'active' AND id != ?
        AND json_extract(properties, '$.core') = 1
    `).all(scope, newId) as { id: string }[]
    for (const r of rows) this.linkSupersede(newId, r.id, 'manual', stamp)
    return rows.map(r => r.id)
  }

  // === v0.15: task hierarchy (part_of) ===

  /**
   * The part_of rules (the DB guards only the verb): both ends are tasks, no
   * cycles, at most one parent per task. Re-drawing the existing edge is fine
   * (idempotent). Errors start with `Invalid engram:`.
   */
  private assertPartOf(childId: string, parentId: string, opts: { reparent?: boolean } = {}): void {
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
    if (current !== undefined && current !== parentId && !opts.reparent) {
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
  private linkPartOf(childId: string, parentId: string, stamp: Stamp): boolean {
    this.assertPartOf(childId, parentId)
    const info = this.db.prepare(`
      INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, created_at)
      VALUES (?, ?, ?, 'part_of', 'agent_declared', 1.0, ?)
      ON CONFLICT(source_id, target_id, relation) DO NOTHING
    `).run(stamp.newId(), childId, parentId, stamp.at)
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

  // === v0.19: the task lifecycle (eml_track_task) ===

  /** A server-written change entry in a task's journal (at the task's current stage). */
  private appendTaskChange(taskId: string, text: string, stamp: Stamp): Entry {
    const row = this.db.prepare('SELECT properties FROM engrams WHERE id = ?').get(taskId) as { properties: string | null } | undefined
    const stage = row?.properties ? JSON.parse(row.properties).stage ?? null : null
    const entry = appendEntry(this.db, taskId, { kind: 'change', text, stage }, stamp)
    return entry
  }

  /** A task superseded by a new one hands its bound items over (S2). Only the edge moves: no field of the item changes, so its rev stays. */
  private moveBoundItems(oldTaskId: string, newTaskId: string, stamp: Stamp): void {
    const items = this.boundItems(oldTaskId)
    for (const item of items) {
      const rel = item.type === 'decision' ? 'derived_from' : 'refines'
      this.db.prepare(`DELETE FROM relations WHERE source_id = ? AND target_id = ? AND relation = ?`).run(item.id, oldTaskId, rel)
      this.db.prepare(`
        INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, created_at)
        VALUES (?, ?, ?, ?, 'agent_declared', 1.0, ?)
        ON CONFLICT(source_id, target_id, relation) DO NOTHING
      `).run(stamp.newId(), item.id, newTaskId, rel, stamp.at)
      this.appendTaskChange(newTaskId, `${item.type} moved here from ${oldTaskId}: ${item.title ?? item.id} (${item.id})`, stamp)
    }
  }

  /** Close the bound items of a task with it (decisions follow the task's outcome, notes are invalidated). */
  private closeBoundItems(taskId: string, taskStatus: 'resolved' | 'invalidated', keep: readonly string[], stamp: Stamp): { closed: BoundItem[], kept: BoundItem[], entries: Entry[] } {
    const closed: BoundItem[] = []
    const kept: BoundItem[] = []
    const entries: Entry[] = []
    for (const item of this.boundItems(taskId)) {
      const props = this.propsOf(item.id)
      if (keep.includes(item.id)) {
        props.binding = 'standing'
        // a task-bound decision is not reviewed; as standing it starts its review clock now
        const reviewDays = TYPE_REVIEW_DEFAULTS[item.type as EngramType]
        if (reviewDays !== undefined) props.review_due_at = addDays(stamp.at, reviewDays)
        this.db.prepare(`UPDATE engrams SET properties = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(props), stamp.at, item.id)
        bumpRev(this.db, stamp, item.id)
        entries.push(this.appendTaskChange(taskId, `kept as standing: ${item.type} ${item.title ?? item.id} (${item.id})`, stamp))
        kept.push({ ...item })
      } else {
        const status = item.type === 'decision' ? taskStatus : 'invalidated'
        this.db.prepare(`UPDATE engrams SET status = ?, updated_at = ? WHERE id = ?`).run(status, stamp.at, item.id)
        bumpRev(this.db, stamp, item.id)
        // the item's own journal says why it closed; a reopen of the task offers it back by this entry
        appendEntry(this.db, item.id, { kind: 'change', text: `${CLOSED_WITH_TASK} ${taskId}` }, stamp)
        entries.push(this.appendTaskChange(taskId, `closed with the task: ${item.type} ${item.title ?? item.id} (${item.id})`, stamp))
        closed.push({ ...item, status })
      }
    }
    return { closed, kept, entries }
  }

  private propsOf(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT properties FROM engrams WHERE id = ?').get(id) as { properties: string | null } | undefined
    return row?.properties ? JSON.parse(row.properties) : {}
  }

  /**
   * v0.19: everything that happens to an existing task — progress, stage, start,
   * close, reopen, edits. `text` becomes a note entry; every field change gets
   * a change entry. Rules: text is required for progress (a call with nothing
   * else), a stage or status change, closing, reopening and a content rewrite;
   * closing needs an outcome and an open task (closed → closed is reopen +
   * close); bound decisions and notes close with the task unless kept (an
   * absent `keep` with bound items errors with their list); a parent can't be
   * closed while a sub-task is open. `supersedes` replaces other open tasks by this one (their
   * bound items move here); `scope` moves the task. Returns null for an
   * unknown id.
   */
  trackTask(id: string, input: TrackTaskInput, stamp: Stamp): StoredEngram | null {
    const existing = this.db.prepare('SELECT * FROM engrams WHERE id = ?').get(id) as any
    if (!existing) return null
    if (existing.type !== 'task') throw new Error(`Invalid engram: ${id} is a ${existing.type}, not a task — use eml_update.`)

    const unknown = Object.keys(input).filter(k => !TRACK_TASK_KEYS.has(k) && (input as unknown as Record<string, unknown>)[k] !== undefined)
    if (unknown.length > 0) throw unknownFieldsError('task', unknown, [...TRACK_TASK_KEYS])

    const old = existing.properties ? JSON.parse(existing.properties) : {}
    const text = typeof input.text === 'string' && input.text.trim() !== '' ? input.text : undefined
    const wasOpen = (TASK_OPEN_STATUSES as readonly string[]).includes(existing.status)
    const newStatus: EngramStatus = input.status ?? existing.status
    if (input.status !== undefined && !(['planned', 'active', 'resolved', 'invalidated'] as string[]).includes(input.status)) {
      throw new Error('Invalid engram: a task\'s status is planned, active, resolved or invalidated (superseded comes from eml_create_task supersedes).')
    }
    const statusChanged = newStatus !== existing.status
    const closing = statusChanged && (newStatus === 'resolved' || newStatus === 'invalidated')
    const reopening = statusChanged && !wasOpen && (newStatus === 'planned' || newStatus === 'active')
    if (existing.status === 'superseded' && statusChanged) {
      throw new Error('Invalid engram: a superseded task stays superseded — continue on its successor.')
    }
    // a closed task replaced by another one reopens only once its successor is invalidated
    if (reopening) this.assertNoLiveSuccessor(id)
    // closed → closed is not a close: the outcome changes by reopening and closing
    // again (both in the journal). The current status repeated without an outcome
    // is a no-op. Checked before the field rules, so the answer names the state.
    const closesAgain = input.status !== undefined && !wasOpen && existing.status !== 'superseded'
      && (input.status === 'resolved' || input.status === 'invalidated')
      && (input.status !== existing.status || input.outcome !== undefined)
    if (closesAgain) {
      throw new Error(`Invalid engram: task ${id} is already ${existing.status} — to change how it ended, reopen it (status planned or active) and close it again.`)
    }
    const supersedePlan = this.planSupersedes([...new Set(input.supersedes ?? [])], { id, type: 'task', status: newStatus, parentId: input.parent_id })
    if (input.scope !== undefined && input.scope !== existing.scope) this.validateScope(input.scope)

    // the typed fields this call sets (null clears an optional one)
    const fieldPatch: Record<string, unknown> = {}
    for (const k of ['context', 'priority', 'assignee_id', 'due_date', 'blockers', 'stage'] as const) {
      if (input[k] !== undefined) fieldPatch[k] = input[k]
    }
    if (input.outcome !== undefined) fieldPatch.outcome = input.outcome
    validateFields('task', fieldPatch, 'update')

    const stageChanged = input.stage !== undefined && (input.stage ?? undefined) !== old.stage
    const contentChanged = input.content !== undefined && input.content !== existing.content
    const nothing = Object.keys(input).filter(k => k !== 'text' && (input as unknown as Record<string, unknown>)[k] !== undefined).length === 0
    if (nothing && !text) throw new Error('Invalid engram: nothing to track — pass text (progress) or a field to change.')
    const needsText = stageChanged || closing || reopening || contentChanged
    if (needsText && !text) {
      const what = closing ? 'closing' : reopening ? 'reopening' : stageChanged ? 'a stage change' : 'a content rewrite'
      throw new Error(`Invalid engram: ${what} needs text — what happened and why (no date, entries are timestamped).`)
    }

    // stage frozen while closed (thaws on reopen)
    const staysClosed = !wasOpen && !(TASK_OPEN_STATUSES as readonly string[]).includes(newStatus)
    if (staysClosed && stageChanged) throw new Error('Invalid engram: stage is frozen while a task is closed — reopen it first.')
    if (input.outcome !== undefined && !closing) {
      throw new Error('Invalid engram: outcome is set when the task closes (status resolved or invalidated).')
    }
    if (closing && isBlank(input.outcome)) {
      throw new Error('Invalid engram: closing a task needs an outcome — one line, shown in task lists.')
    }
    if (input.keep !== undefined && !closing) throw new Error('Invalid engram: keep is only for closing a task.')
    if (closing) {
      const open = this.openSubtasksOf(id)
      if (open.length > 0) {
        throw new Error(`Invalid engram: task ${id} has open sub-tasks: ${open.map(c => `${c.id} ${c.title ?? '(no title)'}`).join(', ')} — close each or move it (eml_track_task(<sub-task id>, parent_id=…)) first.`)
      }
    }
    if (closing) {
      const bound = this.boundItems(id)
      if (bound.length > 0 && input.keep === undefined) {
        throw new Error(
          `Invalid engram: ${bound.length} ${bound.length > 1 ? 'items are' : 'item is'} bound to this task and close${bound.length > 1 ? '' : 's'} with it: ` +
          bound.map(b => `${b.type} ${b.title ?? '(no title)'} (${b.id})`).join('; ') + '. ' +
          'Pass keep=[ids] for the ones that still hold once the task is done (they become standing; say why in text), or keep=[] to close them all.',
        )
      }
      const unknownKeep = (input.keep ?? []).filter(k => !bound.some(b => b.id === k))
      if (unknownKeep.length > 0) throw new Error(`Invalid engram: keep ${unknownKeep.join(', ')} — not bound to this task.`)
    }
    if (input.content !== undefined) {
      if (isBlank(input.content)) throw new Error('Invalid engram: content must not be empty.')
      validateNoTemplateLeak(input.content)
    }
    if (input.title !== undefined && isBlank(input.title)) throw new Error('Invalid engram: a task needs a title.')
    if (input.parent_id !== undefined && input.parent_id !== null) this.assertPartOf(id, input.parent_id, { reparent: true })
    const tagSlugs = input.tags !== undefined ? this.normalizeAndValidateTags(input.tags, this.tagsOf(id)) : undefined
    const subjectSlugs = input.subjects !== undefined ? this.normalizeAndValidateSubjects(input.subjects) : undefined

    const written: Entry[] = []
    let closedWith: BoundItem[] = []
    let kept: BoundItem[] = []
    let reopenCandidates: BoundItem[] = []
    const openSubtasks: OpenSubtask[] = []
    const superseded: string[] = []
    let wikilinks: { resolved: string[]; unresolved: string[] } = { resolved: [], unresolved: [] }
    const scopeChanged = input.scope !== undefined && input.scope !== existing.scope
    this.db.transaction(() => {
      const props = { ...old }
      for (const [k, v] of Object.entries(fieldPatch)) {
        if (v === null) delete props[k]
        else props[k] = v
      }
      if (reopening) delete props.outcome
      const sets: string[] = ['properties = ?']
      const params: unknown[] = [JSON.stringify(props)]
      if (statusChanged) { sets.push('status = ?'); params.push(newStatus) }
      if (input.content !== undefined) { sets.push('content = ?'); params.push(input.content) }
      if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
      if (scopeChanged) { sets.push('scope = ?'); params.push(input.scope) }
      sets.push('updated_at = ?')
      this.db.prepare(`UPDATE engrams SET ${sets.join(', ')} WHERE id = ?`).run(...params, stamp.at, id)
      bumpRev(this.db, stamp, id)
      if (input.content !== undefined || input.title !== undefined || scopeChanged) {
        this.db.prepare('DELETE FROM engrams_fts WHERE id = ?').run(id)
        this.db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) SELECT id, content, scope, COALESCE(title, '') FROM engrams WHERE id = ?`).run(id)
      }
      if (contentChanged) wikilinks = this.materializeWikilinks(id, input.content!, input.scope ?? existing.scope, stamp)

      if (text) written.push(appendEntry(this.db, id, { kind: 'note', text, stage: props.stage ?? null }, stamp))
      const change = (t: string) => written.push(this.appendTaskChange(id, t, stamp))
      const show = (v: unknown) => v === undefined || v === null ? 'none' : Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : String(v)
      if (statusChanged) {
        if (closing) change(`${newStatus}: ${input.outcome}`)
        else if (reopening) change(`reopened (${newStatus})`)
        else change(`status ${existing.status} → ${newStatus}`)
      }
      if (stageChanged) change(`stage ${show(old.stage)} → ${show(input.stage)}`)
      for (const k of ['priority', 'assignee_id', 'due_date'] as const) {
        if (input[k] !== undefined && (input[k] ?? undefined) !== old[k]) change(`${k} ${show(old[k])} → ${show(input[k])}`)
      }
      if (input.blockers !== undefined && JSON.stringify(input.blockers ?? []) !== JSON.stringify(old.blockers ?? [])) {
        change(`blockers ${show(old.blockers)} → ${show(input.blockers)}`)
      }
      if (input.context !== undefined && (input.context ?? undefined) !== old.context) change('context changed')
      if (contentChanged) change('content rewritten')
      if (input.title !== undefined && input.title !== existing.title) change(`title ${existing.title ?? 'none'} → ${input.title}`)
      if (scopeChanged) change(`scope ${existing.scope} → ${input.scope}`)
      const replaced = this.applySupersedes(id, supersedePlan, stamp)
      superseded.push(...replaced.superseded)
      openSubtasks.push(...replaced.openSubtasks)

      if (input.parent_id !== undefined) {
        const current = this.parentOf(id)
        if ((input.parent_id ?? undefined) !== current) {
          if (current !== undefined) this.db.prepare(`DELETE FROM relations WHERE source_id = ? AND relation = 'part_of'`).run(id)
          if (input.parent_id !== null) this.linkPartOf(id, input.parent_id, stamp)
          change(`parent ${current ?? 'none'} → ${input.parent_id ?? 'none'}`)
        }
      }
      if (tagSlugs !== undefined) { this.replaceEngramTags(id, tagSlugs, stamp); change(`tags → ${show(tagSlugs)}`) }
      if (subjectSlugs !== undefined) { this.replaceEngramSubjects(id, subjectSlugs, stamp); change(`subjects → ${show(subjectSlugs)}`) }

      if (closing) {
        const r = this.closeBoundItems(id, newStatus as 'resolved' | 'invalidated', input.keep ?? [], stamp)
        closedWith = r.closed
        kept = r.kept
        written.push(...r.entries)
      }
      // what a reopen may bring back: the bound items that closed with it (an offer, never automatic)
      if (reopening) {
        // the supersede is undone: its edge goes, so the task can be replaced again
        this.db.prepare(`DELETE FROM relations WHERE target_id = ? AND relation = 'supersedes'`).run(id)
        reopenCandidates = this.closedWithTask(id)
      }
    })()

    if (wikilinks.unresolved.length > 0) {
      console.warn(`[EML] unresolved wikilink(s) in engram ${id}: ${wikilinks.unresolved.map(t => `[[${t}]]`).join(' ')}`)
    }
    const updated = this.getRaw(id, stamp.at)!
    return {
      ...updated,
      entries_written: written,
      ...(closedWith.length > 0 ? { closed_with_task: closedWith } : {}),
      ...(kept.length > 0 ? { kept } : {}),
      ...(reopenCandidates.length > 0 ? { reopen_candidates: reopenCandidates } : {}),
      ...(superseded.length > 0 ? { superseded } : {}),
      ...(openSubtasks.length > 0 ? { open_subtasks: openSubtasks } : {}),
      ...(wikilinks.unresolved.length > 0 ? { unresolved_links: wikilinks.unresolved } : {}),
    }
  }

  /**
   * The bound items that closed with this task and stayed closed since: their
   * last change entry is that close. One closed by hand never carries it.
   */
  private closedWithTask(taskId: string): BoundItem[] {
    const marker = `${CLOSED_WITH_TASK} ${taskId}`
    return this.boundItems(taskId, ['resolved', 'invalidated']).filter(item => {
      if (this.liveSuccessorOf(item.id) !== undefined) return false  // replaced since: its successor holds
      const changes = this.entries(item.id, ['change'])
      return changes[changes.length - 1]?.text === marker
    })
  }

  /** A successor of `id` that still holds (any status but invalidated). */
  private liveSuccessorOf(id: string): string | undefined {
    return (this.db.prepare(`
      SELECT r.source_id FROM relations r JOIN engrams e ON e.id = r.source_id
      WHERE r.target_id = ? AND r.relation = 'supersedes' AND e.status != 'invalidated'
      ORDER BY r.created_at ASC LIMIT 1
    `).get(id) as { source_id: string } | undefined)?.source_id
  }

  /** Reactivating or reopening `id` needs every successor invalidated. */
  private assertNoLiveSuccessor(id: string): void {
    const successor = this.liveSuccessorOf(id)
    if (successor !== undefined) {
      throw new Error(`Invalid engram: ${id} is replaced by ${successor} — it is reactivated only once its successor is invalidated; until then the successor holds.`)
    }
  }

  private parentOf(id: string): string | undefined {
    return (this.db.prepare(`SELECT target_id FROM relations WHERE source_id = ? AND relation = 'part_of'`).get(id) as { target_id: string } | undefined)?.target_id
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
  private findPotentialConflicts(engram: Engram, now: string): ConflictCandidate[] {
    const salient = extractSalientTerms(engram.title, engram.content)
    if (salient.length === 0) return []

    // search_mode 'or' = fuzzy recall path (NOT list's implicit AND); order_by
    // 'score' = BM25 ranking. Generous limit → over-fetch; the typed+scoped
    // candidate set is tiny, so this stays cheap.
    // v0.19: planned tasks are open work too — a new task is compared with them.
    const candidates = this.query({
      search: salient.join(' '),
      search_mode: 'or',
      scope: engram.scope,
      statuses: ['active', 'planned'],
      order_by: 'score',
      limit: CONFLICT_CANDIDATE_LIMIT,
      now,
    })

    const props = (engram.properties ?? {}) as Record<string, unknown>
    // v0.19: what the write is deliberately tied to (its parent, the task it is
    // bound to, what it supersedes) is not a conflict of it.
    const linked = new Set((this.db.prepare(`
      SELECT target_id AS id FROM relations WHERE source_id = ? AND relation IN ('part_of', 'derived_from', 'refines', 'supersedes')
      UNION SELECT source_id FROM relations WHERE target_id = ? AND relation IN ('part_of', 'derived_from', 'refines', 'supersedes')
    `).all(engram.id, engram.id) as Array<{ id: string }>).map(r => r.id))
    const survivors: ConflictCandidate[] = []
    for (const c of candidates) {
      if (c.id === engram.id) continue                                   // self
      if (linked.has(c.id)) continue                                     // tied to the write on purpose
      if (c.status === 'planned' && c.type !== 'task') continue          // only tasks are open while planned
      if (c.title !== null && c.title === engram.title) continue   // same-title (thread, not conflict)
      if (c.type === 'log' || c.type === 'learning') continue            // never a supersede/merge target
      if ((c.type === 'event') !== (engram.type === 'event')) continue   // events only against events
      if (engram.type === 'event') {
        const cp = (c.properties ?? {}) as Record<string, unknown>
        const gap = Math.abs(Date.parse(String(cp.occurred_at)) - Date.parse(String(props.occurred_at)))
        if (cp.change_type !== props.change_type || !(gap <= EVENT_DUPLICATE_WINDOW_MS)) continue
      }
      const coverage = termCoverage(salient, `${c.title ?? ''} ${c.content}`)
      if (coverage < CONFLICT_COVERAGE_THRESHOLD) continue               // the load-bearing gate
      if (Math.round(coverage * salient.length) < CONFLICT_MIN_SHARED_TERMS) continue  // a short write needs real overlap
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
  private autoSupersedeStatusEngrams(newId: string, scope: string, stamp: Stamp): string[] {
    const oldRows = this.db.prepare(`
      SELECT id FROM engrams
      WHERE scope = ?
        AND type = 'status' AND status = 'active'
        AND id != ?
    `).all(scope, newId) as { id: string }[]

    for (const old of oldRows) this.linkSupersede(newId, old.id, 'manual', stamp)
    return oldRows.map(r => r.id)
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
  private materializeWikilinks(sourceId: string, content: string, sourceScope: string, stamp: Stamp): { resolved: string[]; unresolved: string[] } {
    const resolved: string[] = []
    const unresolved: string[] = []
    const ins = this.db.prepare(`
      INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, metadata, created_at)
      VALUES (?, ?, ?, 'related_to', 'agent_declared', 1.0, ?, ?)
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
      if (!typed.get(sourceId, targetId)) ins.run(stamp.newId(), sourceId, targetId, META, stamp.at)
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
   * declared at write time). Only an open engram (active, a planned task) is
   * flipped: a closed one keeps how it ended and only gets the edge (decision
   * supersede-rules); the edge INSERT is idempotent via ON CONFLICT. MUST run inside
   * store()'s transaction so the flip + edge commit atomically with the new row.
   */
  private linkSupersede(newId: string, oldId: string, detection: DetectionMethod, stamp: Stamp): void {
    this.db.prepare(`
      UPDATE engrams SET status = 'superseded', updated_at = ?
      WHERE id = ? AND status IN ('active', 'planned')
    `).run(stamp.at, oldId)
    bumpRev(this.db, stamp, oldId)
    this.db.prepare(`
      INSERT INTO relations (id, source_id, target_id,
        relation, detection_method, strength, created_at)
      VALUES (?, ?, ?, 'supersedes', ?, 1.0, ?)
      ON CONFLICT(source_id, target_id, relation) DO NOTHING
    `).run(stamp.newId(), newId, oldId, detection, stamp.at)
    this.dropWikilinkEcho(newId, oldId)
  }

  /**
   * v0.12: normalize incoming tag ids to slugs (consistent with tag creation, so
   * ["Deploy"] resolves to "deploy") and validate them all against the registry in
   * ONE query. Throws naming EVERY unknown tag; returns the normalized slug list to
   * persist. Enforces "only registered tags are usable" at the write path.
   */
  private normalizeAndValidateTags(tags: string[], current: readonly string[] = []): string[] {
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
    // v0.19: an archived tag stays where it is but is not assigned anew.
    const archived = [...(this.tagStore?.archivedIds(slugs) ?? [])].filter(t => !current.includes(t))
    if (archived.length > 0) {
      throw new Error(`Invalid engram: tag "${archived.join('", "')}" is archived — it stays on the engrams that carry it but is not assigned anew; pick an active one (eml_read_object object=tag).`)
    }
    return slugs
  }

  private tagsOf(id: string): string[] {
    return (this.db.prepare('SELECT tag_id FROM engram_tags WHERE engram_id = ?').all(id) as Array<{ tag_id: string }>).map(r => r.tag_id)
  }

  private subjectsOf(id: string): string[] {
    return (this.db.prepare('SELECT subject_id FROM engram_subjects WHERE engram_id = ?').all(id) as Array<{ subject_id: string }>).map(r => r.subject_id)
  }

  private insertEngramTags(engramId: string, tags: string[], stamp: Stamp): void {
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO engram_tags (engram_id, tag_id, created_at) VALUES (?, ?, ?)'
    )
    for (const t of tags) ins.run(engramId, t, stamp.at)
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

  private insertEngramSubjects(engramId: string, subjects: string[], stamp: Stamp): void {
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO engram_subjects (engram_id, subject_id, created_at) VALUES (?, ?, ?)'
    )
    for (const t of subjects) ins.run(engramId, t, stamp.at)
  }

  /** v0.14: full-set replace of an engram's subject memberships (update semantics). */
  private replaceEngramSubjects(engramId: string, subjects: string[], stamp: Stamp): void {
    this.db.prepare('DELETE FROM engram_subjects WHERE engram_id = ?').run(engramId)
    this.insertEngramSubjects(engramId, subjects, stamp)
  }

  /** v0.12: full-set replace of an engram's tag memberships (update semantics). */
  private replaceEngramTags(engramId: string, tags: string[], stamp: Stamp): void {
    this.db.prepare('DELETE FROM engram_tags WHERE engram_id = ?').run(engramId)
    this.insertEngramTags(engramId, tags, stamp)
  }

  /**
   * v0.19: correct or retire an existing engram of any type except task
   * (trackTask). Only the universal fields and the type's own fields; a null
   * clears an optional field. status: invalidated · active (a
   * reactivation); superseded comes only from supersedes. supersedes (B1):
   * this engram replaces the listed ones after the fact, across types. A status
   * engram takes only invalidated + tags/subjects; an event is corrected, never
   * superseded; a log's START HERE fields corrected from another session leave
   * a change entry on the log.
   * review_note confirms a decision, rule or profile in a review (a review
   * entry). Returns the engram with the diff, or null for an unknown id.
   */
  update(id: string, patch: EngramPatch, stamp: Stamp): StoredEngram | null {
    const actor = stamp.actor
    const existing = this.db.prepare('SELECT * FROM engrams WHERE id = ?').get(id) as any
    if (!existing) return null
    const type = existing.type as EngramType
    if (type === 'task') {
      throw new Error(`Invalid engram: ${id} is a task — everything about a task goes through eml_track_task.`)
    }
    const raw = patch as Record<string, unknown>
    if (raw.type !== undefined) {
      throw new Error('Invalid engram: the type of an engram does not change — write the new engram of the target type with supersedes=[id].')
    }
    const unknown = Object.keys(raw).filter(k => !UPDATE_PATCH_KEYS.has(k) && raw[k] !== undefined)
    if (unknown.length > 0) {
      // the list names what this engram takes: review_note only on a reviewable type, app only with an origin
      const universal = [...UPDATE_PATCH_KEYS].filter(k => k !== 'properties'
        && (k !== 'review_note' || (REVIEWABLE_TYPES as readonly string[]).includes(type))
        && (k !== 'app' || !!existing.origin))
      throw unknownFieldsError(type, unknown, universal.concat(Object.keys(TYPE_FIELDS[type])))
    }
    const fieldPatch: Record<string, unknown> = { ...(patch.properties ?? {}) }
    if (type === 'learning') {
      const other = Object.keys(raw).filter(k => raw[k] !== undefined && !['content', 'title', 'status', 'tags', 'subjects', 'supersedes'].includes(k))
        .concat(Object.keys(fieldPatch))
      if (other.length > 0) {
        throw new Error('Invalid engram: a learning takes content, title, status, tags, subjects and supersedes (a rule or learning) here — new evidence goes through eml_learning(id).')
      }
    }
    // review_due_at: null on a reviewable engram means "restart from the default", not "no review"
    const reviewDefault = TYPE_REVIEW_DEFAULTS[type]
    if (reviewDefault !== undefined && fieldPatch.review_due_at === null) delete fieldPatch.review_due_at
    validateFields(type, fieldPatch, 'update')
    normalizeTimestampFields(fieldPatch)

    let reactivatesSuperseded = false
    if (patch.status !== undefined) {
      if (!(['invalidated', 'active'] as string[]).includes(patch.status)) {
        throw new Error(
          'Invalid engram: status can be set to invalidated or active (a reactivation). ' +
          'Superseded comes from supersedes on the new engram.',
        )
      }
      if (patch.status === 'active' && existing.status !== 'active') {
        // An engram with a successor — superseded, or closed and only linked —
        // comes back only once no successor holds any more; that undoes the supersede.
        this.assertNoLiveSuccessor(id)
        reactivatesSuperseded = this.successorOf(id) !== undefined
      }
    }
    if (type === 'status') {
      const allowed = ['status', 'tags', 'subjects']
      const other = Object.keys(raw).filter(k => raw[k] !== undefined && !allowed.includes(k))
      if (other.length > 0 || (patch.status !== undefined && patch.status !== 'invalidated')) {
        throw new Error('Invalid engram: a status only takes status=invalidated, tags and subjects — a new state is always eml_set_status.')
      }
    }
    if (type === 'learning') {
      if (patch.content !== undefined && patch.content.length > LEARNING_CONTENT_MAX_CHARS) {
        throw new Error(`Invalid engram: a learning's content is at most ${LEARNING_CONTENT_MAX_CHARS} characters (got ${patch.content.length}) — the lesson as an instruction to yourself.`)
      }
    }
    // A learning supersedes a rule that came from a single incident, on the user's word (type rules in planSupersedes).
    const supersedePlan = this.planSupersedes([...new Set(patch.supersedes ?? [])], { id, type, status: patch.status ?? existing.status })
    if (patch.review_note !== undefined) {
      if (!(REVIEWABLE_TYPES as readonly string[]).includes(type)) {
        throw new Error('Invalid engram: review_note confirms a decision, rule or profile in a review.')
      }
      if (isBlank(patch.review_note)) throw new Error('Invalid engram: review_note must say why it still holds.')
      if ((patch.status ?? existing.status) !== 'active') {
        throw new Error(`Invalid engram: ${id} is ${existing.status} — a review confirms an active engram.`)
      }
    }
    // A log's START HERE fields are correctable from any session; a correction
    // from another session is noted on the log (decision v0.19-log-corrections-any-session).
    let logCorrection: string | null = null
    if (type === 'log') {
      const own = !!actor.session_id && actor.session_id === existing.session_id
      const startHere = ['what', 'landed', 'next', 'open_threads'].filter(k => fieldPatch[k] !== undefined)
      if (startHere.length > 0 && !own) {
        logCorrection = `${startHere.join(', ')} corrected from session ${actor.session_id ?? '(unknown)'}`
      }
    }
    if (patch.content !== undefined) {
      if (isBlank(patch.content) && type !== 'log') throw new Error('Invalid engram: content must not be empty.')
      validateNoTemplateLeak(patch.content)
    }
    if (patch.title !== undefined && patch.title !== null && isBlank(patch.title)) throw new Error('Invalid engram: title must not be empty.')
    if (patch.title === null && type !== 'note') throw new Error(`Invalid engram: ${type === 'event' ? 'an' : 'a'} ${type} needs a title.`)
    if (patch.app !== undefined) {
      if (!existing.origin) throw new Error('Invalid engram: app state belongs to an engram written by software (one with an origin).')
      const p = fieldProblem('app', { kind: 'map' }, patch.app)
      if (p) throw new Error(`Invalid engram: ${p}`)
    }

    // the merged fields
    const oldProps: Record<string, unknown> = existing.properties ? JSON.parse(existing.properties) : {}
    let newProps: Record<string, unknown> = { ...oldProps }
    for (const [k, v] of Object.entries(fieldPatch)) {
      if (v === null) delete newProps[k]
      else newProps[k] = v
    }
    if (patch.app !== undefined) newProps.app = patch.app
    const newScope = patch.scope ?? existing.scope
    // The profile scope rule applies to a move; a legacy profile elsewhere stays editable (and retirable).
    if (type === 'profile' && patch.scope !== undefined && patch.scope !== existing.scope && !/^(agent|user|entity)\./.test(newScope)) {
      throw new Error('Invalid engram: a profile is about someone — scope agent.<id>, user.<id> or entity.<id>.')
    }
    if ((type === 'decision' || type === 'note') && fieldPatch.binding === 'task') {
      const linked = this.boundTaskOf(id)
      if (!linked) throw new Error(`Invalid engram: binding task needs a task — this ${type} is not linked to one.`)
      this.assertTaskOpenForBinding(linked.id, type)
    }
    const newStatus = patch.status ?? existing.status
    // A task-bound item closed with its task comes back with the task: reopening the
    // task lists it to reactivate. Alone it is reactivated only as a standing item.
    if ((type === 'decision' || type === 'note') && newStatus === 'active' && existing.status !== 'active' && newProps.binding === 'task') {
      const linked = this.boundTaskOf(id)
      if (linked && !(TASK_OPEN_STATUSES as readonly string[]).includes(linked.status)) {
        throw new Error(`Invalid engram: task ${linked.id} is ${linked.status} — a ${type} bound to it stays closed with it; reopen the task first (eml_track_task status planned or active lists it to reactivate), or make it standing (binding=standing) in the same call.`)
      }
    }
    // One core profile per scope: an explicit core=true replaces the current one;
    // a reactivation or a move into a scope that has one is refused, not silently retiring it.
    const coreNewlySet = newProps.core === true && oldProps.core !== true
    if (type === 'profile' && newProps.core === true && newStatus === 'active' && !coreNewlySet) {
      const arriving = existing.status !== 'active' || (patch.scope !== undefined && patch.scope !== existing.scope)
      const other = arriving ? this.activeCoreProfileIn(newScope, id) : null
      if (other) {
        throw new Error(`Invalid engram: scope ${newScope} already has a core profile (${other}) — invalidate it first, or write the identity as a new profile with core=true (eml_profile), which replaces the current one.`)
      }
    }
    const formatTouched = (patch.content !== undefined && patch.content !== existing.content)
      || newProps.trigger !== oldProps.trigger || newProps.applies !== oldProps.applies
    if (formatTouched) validateFormat(type, patch.content ?? existing.content, newProps)

    let newContent: string | undefined = patch.content
    if (type === 'log' && (patch.content !== undefined || ['what', 'landed', 'next', 'open_threads'].some(k => fieldPatch[k] !== undefined))) {
      // The START HERE block is rendered from the fields; the rest is the narrative.
      const oldBlock = renderLogContent(oldProps, '')
      const narrative = patch.content ?? (existing.content.startsWith(oldBlock) ? existing.content.slice(oldBlock.length).replace(/^\n+/, '') : existing.content)
      newContent = hasStartHere(newProps) ? renderLogContent(newProps, narrative) : narrative
    }

    // review: a substantive edit restarts it; review_note confirms it
    const reviewDays = TYPE_REVIEW_DEFAULTS[type]
    const substantive = (newContent !== undefined && newContent !== existing.content)
      || (patch.title !== undefined && patch.title !== existing.title)
      || (patch.scope !== undefined && patch.scope !== existing.scope)
      || Object.keys(fieldPatch).some(k => k !== 'review_due_at' && JSON.stringify(newProps[k]) !== JSON.stringify(oldProps[k]))
    const restartAsked = (patch.properties as Record<string, unknown> | undefined)?.review_due_at === null
    const reviewed = reviewDays !== undefined && newStatus === 'active' && (substantive || restartAsked || patch.review_note !== undefined)
    if (reviewed && fieldPatch.review_due_at === undefined) {
      newProps = { ...newProps, review_due_at: addDays(stamp.at, reviewDays!) }
    }

    if (patch.scope !== undefined && patch.scope !== existing.scope) this.validateScope(patch.scope)
    const tagSlugs = patch.tags !== undefined ? this.normalizeAndValidateTags(patch.tags, this.tagsOf(id)) : undefined
    const subjectSlugs = patch.subjects !== undefined ? this.normalizeAndValidateSubjects(patch.subjects) : undefined
    // a set equal to the stored one is no change (no write, no rev)
    const tagsChange = tagSlugs !== undefined && !sameSet(tagSlugs, this.tagsOf(id)) ? tagSlugs : undefined
    const subjectsChange = subjectSlugs !== undefined && !sameSet(subjectSlugs, this.subjectsOf(id)) ? subjectSlugs : undefined

    // the diff (what the response shows)
    const diff: Record<string, [unknown, unknown]> = {}
    if (newContent !== undefined && newContent !== existing.content) diff.content = [existing.content, newContent]
    if (patch.title !== undefined && patch.title !== existing.title) diff.title = [existing.title, patch.title]
    if (patch.scope !== undefined && patch.scope !== existing.scope) diff.scope = [existing.scope, patch.scope]
    if (patch.status !== undefined && patch.status !== existing.status) diff.status = [existing.status, patch.status]
    for (const k of new Set([...Object.keys(oldProps), ...Object.keys(newProps)])) {
      if (JSON.stringify(oldProps[k]) !== JSON.stringify(newProps[k])) diff[k] = [oldProps[k] ?? null, newProps[k] ?? null]
    }

    const contentChanged = newContent !== undefined && newContent !== existing.content
    const titleChanged = patch.title !== undefined && patch.title !== existing.title
    const scopeChanged = patch.scope !== undefined && patch.scope !== existing.scope
    const superseded: string[] = []
    let wikilinks: { resolved: string[]; unresolved: string[] } = { resolved: [], unresolved: [] }
    this.db.transaction(() => {
      if (type === 'profile' && newProps.core === true && oldProps.core !== true && newStatus === 'active') {
        superseded.push(...this.autoSupersedeCoreProfile(id, newScope, stamp))
      }
      const sets: string[] = []
      const params: unknown[] = []
      // only what differs from the stored values: a patch that changes nothing writes nothing (no updated_at, no rev)
      if (contentChanged) { sets.push('content = ?'); params.push(newContent) }
      if (titleChanged) { sets.push('title = ?'); params.push(patch.title) }
      if (scopeChanged) { sets.push('scope = ?'); params.push(patch.scope) }
      if (patch.status !== undefined && patch.status !== existing.status) { sets.push('status = ?'); params.push(patch.status) }
      if (JSON.stringify(newProps) !== JSON.stringify(oldProps)) { sets.push('properties = ?'); params.push(JSON.stringify(newProps)) }
      if (sets.length > 0 || tagsChange !== undefined || subjectsChange !== undefined || supersedePlan.size > 0 || patch.review_note !== undefined) {
        sets.push('updated_at = ?')
        this.db.prepare(`UPDATE engrams SET ${sets.join(', ')} WHERE id = ?`).run(...params, stamp.at, id)
        bumpRev(this.db, stamp, id)
      }
      if (contentChanged || scopeChanged || titleChanged) {
        this.db.prepare('DELETE FROM engrams_fts WHERE id = ?').run(id)
        this.db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) SELECT id, content, scope, COALESCE(title, '') FROM engrams WHERE id = ?`).run(id)
      }
      if (tagsChange !== undefined) this.replaceEngramTags(id, tagsChange, stamp)
      if (subjectsChange !== undefined) this.replaceEngramSubjects(id, subjectsChange, stamp)
      if (contentChanged) wikilinks = this.materializeWikilinks(id, newContent!, newScope, stamp)
      superseded.push(...this.applySupersedes(id, supersedePlan, stamp).superseded)
      if (patch.review_note !== undefined) appendEntry(this.db, id, { kind: 'review', text: patch.review_note }, stamp)
      // a decision's or note's status change goes into its journal (a reopen of its task reads the last one)
      if ((type === 'decision' || type === 'note') && newStatus !== existing.status) {
        appendEntry(this.db, id, { kind: 'change', text: `status ${existing.status} → ${newStatus}` }, stamp)
      }
      // the supersede is undone: its edge goes, so the engram can be superseded again
      if (reactivatesSuperseded) this.db.prepare(`DELETE FROM relations WHERE target_id = ? AND relation = 'supersedes'`).run(id)
      if (logCorrection) appendEntry(this.db, id, { kind: 'change', text: logCorrection }, stamp)
      if (type === 'learning' && patch.content !== undefined && patch.content !== existing.content) {
        appendEntry(this.db, id, { kind: 'change', text: LEARNING_SHARPENED }, stamp)
      }
    })()

    if (wikilinks.unresolved.length > 0) {
      console.warn(`[EML] unresolved wikilink(s) in engram ${id}: ${wikilinks.unresolved.map(t => `[[${t}]]`).join(' ')}`)
    }

    const updated = this.getRaw(id, stamp.at)!
    return {
      ...updated,
      diff,
      ...(superseded.length > 0 ? { superseded } : {}),
      ...(wikilinks.unresolved.length > 0 ? { unresolved_links: wikilinks.unresolved } : {}),
      ...(type === 'learning' ? { learning: learningState(this.entries(id)) } : {}),
    }
  }

  /**
   * Confirm in a review that an engram still holds. A decision, rule or
   * profile gets a review entry (why it still holds) and a new review_due_at;
   * a task is flagged for inactivity, so confirming it counts as a movement.
   * Either way it is no longer review_due.
   */
  confirmReview(id: string, text: string | undefined, stamp: Stamp): Engram | null {
    const existing = this.db.prepare('SELECT * FROM engrams WHERE id = ?').get(id) as any
    if (!existing) return null
    const live = existing.type === 'task' ? (TASK_OPEN_STATUSES as readonly string[]).includes(existing.status) : existing.status === 'active'
    if (!live) throw new Error(`Invalid engram: ${id} is ${existing.status} — a review confirms an active engram${existing.type === 'task' ? ' (an open task)' : ''}.`)
    if (existing.type === 'task') {
      this.db.transaction(() => {
        this.db.prepare(`UPDATE engrams SET updated_at = ? WHERE id = ?`).run(stamp.at, id)
        bumpRev(this.db, stamp, id)
        if (text && text.trim() !== '') {
          appendEntry(this.db, id, { kind: 'note', text, stage: this.propsOf(id).stage as string ?? null }, stamp)
        }
      })()
      return this.getRaw(id, stamp.at)
    }
    const reviewDays = TYPE_REVIEW_DEFAULTS[existing.type as keyof typeof TYPE_REVIEW_DEFAULTS]
    if (reviewDays === undefined) {
      throw new Error(`Invalid engram: a review is confirmed for a decision, rule, profile or task (got ${existing.type}).`)
    }
    if (isBlank(text)) throw new Error('Invalid engram: confirming a review needs text — why it still holds.')
    this.db.transaction(() => {
      const props = existing.properties ? JSON.parse(existing.properties) : {}
      props.review_due_at = addDays(stamp.at, reviewDays)
      this.db.prepare(`UPDATE engrams SET properties = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(props), stamp.at, id)
      bumpRev(this.db, stamp, id)
      appendEntry(this.db, id, { kind: 'review', text: text! }, stamp)
    })()
    return this.getRaw(id, stamp.at)
  }

  // === v0.19: learnings (eml_learning) ===

  /**
   * v0.20: engram.create with type learning — a new lesson with its first
   * evidence. The topic is checked first: an active learning on the same topic
   * in the scope or the session's agent/user scopes → nothing is written, the
   * response names the match (pass its id, or new_topic=true for a different topic).
   */
  createLearning(input: Omit<LearnInput, 'id'>, stamp: Stamp): LearnResult {
    if ((input as LearnInput).id !== undefined) throw new Error('Invalid engram: a new learning has no id — evidence for an existing one is learning.add_evidence.')
    return this.learn(input, stamp)
  }

  /** v0.20: learning.add_evidence — an incident added to an existing learning (journal-style, like task.track). */
  addEvidence(input: LearnInput & { id: string }, stamp: Stamp): Extract<LearnResult, { written: true }> {
    return this.learn(input, stamp) as Extract<LearnResult, { written: true }>
  }

  /** Both halves share one set of evidence rules and messages. */
  private learn(input: LearnInput, stamp: Stamp): LearnResult {
    const actor = stamp.actor
    const unknown = Object.keys(input).filter(k => !LEARN_KEYS.has(k) && (input as unknown as Record<string, unknown>)[k] !== undefined)
    if (unknown.length > 0) throw unknownFieldsError('learning', unknown, [...LEARN_KEYS])
    if (!(EVIDENCE_SOURCES as readonly string[]).includes(input.source as string)) {
      throw new Error(`Invalid engram: source must be one of ${EVIDENCE_SOURCES.join(', ')} — where this evidence comes from.`)
    }
    const stance = input.stance ?? 'supports'
    if (!(EVIDENCE_STANCES as readonly string[]).includes(stance)) {
      throw new Error(`Invalid engram: stance must be one of ${EVIDENCE_STANCES.join(', ')}.`)
    }
    if (isBlank(input.happened)) throw new Error('Invalid engram: happened is required — what concretely happened in this incident.')
    if ((input.source === 'user' || stance === 'declined') && isBlank(input.quote)) {
      throw new Error(`Invalid engram: ${stance === 'declined' ? 'a decline' : 'evidence from the user'} needs quote — the user's words, verbatim.`)
    }
    if (input.content !== undefined) {
      if (isBlank(input.content)) throw new Error('Invalid engram: content must not be empty — the lesson as an instruction to yourself.')
      validateNoTemplateLeak(input.content)
      if (input.content.length > LEARNING_CONTENT_MAX_CHARS) {
        throw new Error(`Invalid engram: a learning's content is at most ${LEARNING_CONTENT_MAX_CHARS} characters (got ${input.content.length}) — the lesson as an instruction to yourself.`)
      }
    }
    if (input.rule_id !== undefined) {
      const r = this.db.prepare('SELECT type FROM engrams WHERE id = ?').get(input.rule_id) as { type: string } | undefined
      if (r?.type !== 'rule') throw new Error(`Invalid engram: rule_id ${input.rule_id} is not a rule.`)
    }
    const evidence: EntryInput = {
      kind: 'evidence', text: input.happened, source: input.source as EvidenceSource, stance: stance as EvidenceStance,
      ...(input.quote !== undefined ? { quote: input.quote } : {}),
      ...(input.rule_id !== undefined ? { rule_id: input.rule_id } : {}),
    }

    // --- add to an existing learning ---
    if (input.id !== undefined) {
      const existing = this.db.prepare('SELECT * FROM engrams WHERE id = ?').get(input.id) as any
      if (existing.type !== 'learning') throw new Error(`Invalid engram: ${input.id} is a ${existing.type}, not a learning.`)
      if (existing.status !== 'active') throw new Error(`Invalid engram: learning ${input.id} is ${existing.status} — evidence goes to an active learning.`)
      const extra = ['scope', 'title', 'new_topic', 'tags', 'subjects'].filter(k => (input as unknown as Record<string, unknown>)[k] !== undefined)
      if (extra.length > 0) throw new Error(`Invalid engram: ${extra.join(', ')} only on create — adding evidence takes source, happened, quote, stance, rule_id (and content to sharpen the lesson).`)
      this.db.transaction(() => {
        appendEntry(this.db, input.id!, evidence, stamp)
        if (input.content !== undefined && input.content !== existing.content) {
          this.db.prepare(`UPDATE engrams SET content = ?, updated_at = ? WHERE id = ?`).run(input.content, stamp.at, input.id)
          bumpRev(this.db, stamp, input.id!)
          this.db.prepare('DELETE FROM engrams_fts WHERE id = ?').run(input.id)
          this.db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) SELECT id, content, scope, COALESCE(title, '') FROM engrams WHERE id = ?`).run(input.id)
          appendEntry(this.db, input.id!, { kind: 'change', text: LEARNING_SHARPENED }, stamp)
        } else {
          this.db.prepare(`UPDATE engrams SET updated_at = ? WHERE id = ?`).run(stamp.at, input.id)
          bumpRev(this.db, stamp, input.id!)
        }
      })()
      const engram = this.getRaw(input.id, stamp.at)!
      return { written: true, engram, learning: learningState(this.entries(input.id)) }
    }

    // --- create ---
    if (stance !== 'supports') throw new Error('Invalid engram: a new learning starts from supporting evidence.')
    if (isBlank(input.content)) throw new Error('Invalid engram: a new learning needs content — the lesson as an instruction to yourself.')
    if (isBlank(input.scope)) throw new Error('Invalid engram: a new learning needs scope (usually user.<id>).')
    if (isBlank(input.title)) throw new Error('Invalid engram: a new learning needs a title — the topic.')
    this.validateScope(input.scope!)
    if (!input.new_topic) {
      const matches = this.findLearningTopic(input.title!, input.content!, input.scope!, actor.handle, stamp.at)
      if (matches.length > 0) return { written: false, matches }
    }
    const tagSlugs = input.tags !== undefined ? this.normalizeAndValidateTags(input.tags) : undefined
    const subjectSlugs = input.subjects !== undefined ? this.normalizeAndValidateSubjects(input.subjects) : undefined
    const id = stamp.newId()
    const now = stamp.at
    stamp.created.add(id)
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO engrams (id, content, type, scope, title, status, significance, properties,
          ingested_by, ingestion_method, session_id, model, harness, created_at, updated_at, rev)
        VALUES (?, ?, 'learning', ?, ?, 'active', 'normal', NULL, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(id, input.content, input.scope, input.title, actor.handle, actor.ingestion_method,
        actor.session_id, actor.model, actor.harness, now, now)
      this.db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) VALUES (?, ?, ?, ?)`).run(id, input.content, input.scope, input.title)
      appendEntry(this.db, id, evidence, stamp)
      if (tagSlugs && tagSlugs.length > 0) this.insertEngramTags(id, tagSlugs, stamp)
      if (subjectSlugs && subjectSlugs.length > 0) this.insertEngramSubjects(id, subjectSlugs, stamp)
      this.materializeWikilinks(id, input.content!, input.scope!, stamp)
    })()
    return { written: true, engram: this.getRaw(id, stamp.at)!, learning: learningState(this.entries(id)) }
  }

  /**
   * The topic check of eml_learning: active learnings whose title and content
   * cover the new one's salient terms (the conflict gate, run on learnings
   * only), in the scope and the agent / user scopes of the session.
   */
  private findLearningTopic(title: string, content: string, scope: string, caller: string | null, now: string): Array<{ id: string, scope: string, title: string | null, content: string, coverage: number }> {
    const salient = extractSalientTerms(title, content)
    if (salient.length === 0) return []
    const scopes = new Set<string>([scope])
    if (caller) scopes.add(`agent.${caller}`)
    for (const u of this.db.prepare('SELECT id FROM users').all() as Array<{ id: string }>) scopes.add(`user.${u.id}`)
    // the scope filter is part of the query, so the limit applies after it (the C0 bug class)
    const candidates = this.query({ type: 'learning', scopes: [...scopes], search: salient.join(' '), search_mode: 'or', statuses: ['active'], order_by: 'score', limit: CONFLICT_CANDIDATE_LIMIT, now })
    return candidates
      .map(c => ({ id: c.id, scope: c.scope, title: c.title, content: c.content, coverage: Math.round(termCoverage(salient, `${c.title ?? ''} ${c.content}`) * 100) / 100 }))
      .filter(c => c.coverage >= CONFLICT_COVERAGE_THRESHOLD || (c.title !== null && c.title === title))
      .sort((a, b) => b.coverage - a.coverage)
      .slice(0, CONFLICT_MAX)
  }

  /** Returns true if a new edge was inserted, false if it already existed (idempotent). */
  relate(input: RelationInput, stamp: Stamp): boolean {
    // v0.19: supersedes and part_of are not drawn by hand — they come from
    // supersedes on a write and from a task's parent_id.
    if (input.relation === 'supersedes' || input.relation === 'part_of') {
      throw new Error(
        input.relation === 'supersedes'
          ? 'Invalid engram: supersedes is drawn by a write — supersedes on the new engram when you create it, or after the fact eml_update(new_id, supersedes=[old_id]); a task: eml_track_task(new_id, supersedes=[old_id]); a status replaces the previous one by itself.'
          : 'Invalid engram: part_of comes from a task\'s parent — eml_create_task(parent_id) or eml_track_task(parent_id).',
      )
    }
    // A decision or note bound to a task (binding task) belongs to that one task:
    // a second derived_from / refines edge to another task would close it with either.
    if (input.relation === 'derived_from' || input.relation === 'refines') {
      const src = this.db.prepare('SELECT type, properties FROM engrams WHERE id = ?').get(input.source_id) as { type: string, properties: string | null } | undefined
      const tgt = this.db.prepare('SELECT type FROM engrams WHERE id = ?').get(input.target_id) as { type: string } | undefined
      const binding = src?.properties ? JSON.parse(src.properties).binding : undefined
      if (tgt?.type === 'task' && (src?.type === 'decision' || src?.type === 'note') && binding === 'task') {
        const current = this.boundTaskOf(input.source_id)
        if (current && current.id !== input.target_id) {
          throw new Error(`Invalid engram: ${input.source_id} is bound to task ${current.id} — a ${src.type} is bound to one task. Make it standing first (eml_update binding=standing), or relate it with related_to.`)
        }
      }
    }
    const info = this.db.prepare(`
      INSERT INTO relations (id, source_id, target_id,
        relation, detection_method, strength, explanation, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, target_id, relation) DO NOTHING
    `).run(
      stamp.newId(),
      input.source_id, input.target_id,
      input.relation, input.detection_method,
      input.strength ?? 1.0,
      input.explanation ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      stamp.at,
    )
    if (input.relation !== 'related_to') this.dropWikilinkEcho(input.source_id, input.target_id)
    return info.changes > 0
  }

}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every(x => sb.has(x))
}
