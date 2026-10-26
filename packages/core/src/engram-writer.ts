import {
  Engram, EngramInput, RelationInput,
  TYPE_DEFAULT_STATUS, TYPE_REVIEW_DEFAULTS,
  EngramType, StoredEngram,
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
import { type Stamp, addDays } from './env'
import { REVIEWABLE_TYPES } from './review-due'

import { EngramStore, renderLogContent, hasStartHere, CONFLICT_TYPES, CONFLICT_CANDIDATE_LIMIT, CONFLICT_COVERAGE_THRESHOLD, CONFLICT_MAX, STORE_INPUT_KEYS, createInputKeys, TRACK_TASK_KEYS, UPDATE_PATCH_KEYS, LEARN_KEYS, LEARNING_CONTENT_MAX_CHARS, extractSalientTerms, termCoverage, type TrackTaskInput, type EngramPatch, type LearnInput, type LearnResult } from './engrams'
import { propsOf, type WriteContext } from './write/context'
import {
  planSupersedes, applySupersedes, supersede, successorOf, assertNoLiveSuccessor,
  activeStatusState, activeCoreProfileIn, autoSupersedeCoreProfile, autoSupersedeStatusEngrams,
} from './write/supersede'
import {
  normalizeAndValidateTags, normalizeAndValidateSubjects, tagsOf, subjectsOf,
  insertEngramTags, insertEngramSubjects, replaceEngramTags, replaceEngramSubjects,
} from './write/tags-subjects'
import { materializeWikilinks, dropWikilinkEcho } from './write/wikilinks'
import {
  boundTaskOf, assertTaskOpenForBinding, assertPartOf, linkPartOf, parentOf, openSubtasksOf,
  appendTaskChange, closeBoundItems, closedWithTask,
} from './write/task-binding'
import { findPotentialConflicts } from './write/conflicts'

/**
 * v0.20: the write half of the engram store — internal to core. Only the
 * command modules (commands/) call it, inside apply()'s transaction, with the
 * write's one Stamp. EML exposes the read half (EngramStore) and apply().
 */
export class EngramWriter extends EngramStore {
  /** The write context of the helpers in write/: this store's connection and registries, with the write's Stamp. */
  private write(stamp: Stamp): WriteContext {
    return { db: this.db, stamp, store: this, tags: this.tagStore, subjects: this.subjectStore }
  }

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
    const w = this.write(stamp)
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
      if (props.binding === 'task') assertTaskOpenForBinding(w, input.task_id!, type)
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
    const supersedePlan = planSupersedes(w, [...new Set(input.supersedes ?? [])], { id: null, type, status, parentId: input.parent_id })

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
    const tagSlugs = input.tags !== undefined ? normalizeAndValidateTags(w, input.tags) : undefined
    const subjectSlugs = input.subjects !== undefined ? normalizeAndValidateSubjects(w, input.subjects) : undefined

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
      if (type === 'profile' && props.core === true) superseded.push(...autoSupersedeCoreProfile(w, id, input.scope))
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
        previousState = activeStatusState(w, input.scope, id)
        superseded.push(...autoSupersedeStatusEngrams(w, id, input.scope))
      }
      if (type === 'task') {
        const stage = typeof props.stage === 'string' ? ` · stage ${props.stage}` : ''
        appendEntry(this.db, id, { kind: 'change', text: `created (${status}${stage})`, stage: (props.stage as string) ?? null }, stamp)
      }

      const replaced = applySupersedes(w, id, supersedePlan)
      superseded.push(...replaced.superseded)
      openSubtasks.push(...replaced.openSubtasks)
      for (const lid of fromLearning) {
        supersede(w, id, lid)
        superseded.push(lid)
      }

      if (input.parent_id !== undefined) linkPartOf(w, id, input.parent_id)

      // A task-linked write: edge to the task + a change entry in its journal.
      if (input.task_id !== undefined && taskLink) {
        this.db.prepare(`
          INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, created_at)
          VALUES (?, ?, ?, ?, 'agent_declared', 1.0, ?)
          ON CONFLICT(source_id, target_id, relation) DO NOTHING
        `).run(stamp.newId(), id, input.task_id, taskLink, stamp.at)
        const label = input.title ?? (input.content.length > 80 ? `${input.content.slice(0, 80)}…` : input.content)
        const verb = type === 'decision' ? 'taken' : type === 'event' ? 'recorded' : 'written'
        appendTaskChange(w, input.task_id, `${type} ${verb}: ${label} (${id})`)
      }

      if (tagSlugs && tagSlugs.length > 0) insertEngramTags(w, id, tagSlugs)
      if (subjectSlugs && subjectSlugs.length > 0) insertEngramSubjects(w, id, subjectSlugs)
      wikilinks = materializeWikilinks(w, id, content, input.scope)
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
      const potential_conflicts = findPotentialConflicts(w, stored)
      if (potential_conflicts.length > 0) extra.potential_conflicts = potential_conflicts
    }
    return { ...stored, ...extra }
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
    const w = this.write(stamp)
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
    if (reopening) assertNoLiveSuccessor(w, id)
    // closed → closed is not a close: the outcome changes by reopening and closing
    // again (both in the journal). The current status repeated without an outcome
    // is a no-op. Checked before the field rules, so the answer names the state.
    const closesAgain = input.status !== undefined && !wasOpen && existing.status !== 'superseded'
      && (input.status === 'resolved' || input.status === 'invalidated')
      && (input.status !== existing.status || input.outcome !== undefined)
    if (closesAgain) {
      throw new Error(`Invalid engram: task ${id} is already ${existing.status} — to change how it ended, reopen it (status planned or active) and close it again.`)
    }
    const supersedePlan = planSupersedes(w, [...new Set(input.supersedes ?? [])], { id, type: 'task', status: newStatus, parentId: input.parent_id })
    if (input.scope !== undefined && input.scope !== existing.scope) this.validateScope(input.scope)

    // the typed fields this call sets (null clears an optional one)
    const fieldPatch: Record<string, unknown> = {}
    for (const k of ['intent', 'context', 'priority', 'assignee_id', 'due_date', 'blockers', 'stage'] as const) {
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
      const open = openSubtasksOf(w, id)
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
    if (input.parent_id !== undefined && input.parent_id !== null) assertPartOf(w, id, input.parent_id, { reparent: true })
    const tagSlugs = input.tags !== undefined ? normalizeAndValidateTags(w, input.tags, tagsOf(w, id)) : undefined
    const subjectSlugs = input.subjects !== undefined ? normalizeAndValidateSubjects(w, input.subjects) : undefined

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
      if (contentChanged) wikilinks = materializeWikilinks(w, id, input.content!, input.scope ?? existing.scope)

      if (text) written.push(appendEntry(this.db, id, { kind: 'note', text, stage: props.stage ?? null }, stamp))
      const change = (t: string) => written.push(appendTaskChange(w, id, t))
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
      if (input.intent !== undefined && (input.intent ?? undefined) !== old.intent) change(input.intent === null ? 'intent cleared' : old.intent === undefined ? 'intent set' : 'intent changed')
      if (input.context !== undefined && (input.context ?? undefined) !== old.context) change('context changed')
      if (contentChanged) change('content rewritten')
      if (input.title !== undefined && input.title !== existing.title) change(`title ${existing.title ?? 'none'} → ${input.title}`)
      if (scopeChanged) change(`scope ${existing.scope} → ${input.scope}`)
      const replaced = applySupersedes(w, id, supersedePlan)
      superseded.push(...replaced.superseded)
      openSubtasks.push(...replaced.openSubtasks)

      if (input.parent_id !== undefined) {
        const current = parentOf(w, id)
        if ((input.parent_id ?? undefined) !== current) {
          if (current !== undefined) this.db.prepare(`DELETE FROM relations WHERE source_id = ? AND relation = 'part_of'`).run(id)
          if (input.parent_id !== null) linkPartOf(w, id, input.parent_id)
          change(`parent ${current ?? 'none'} → ${input.parent_id ?? 'none'}`)
        }
      }
      if (tagSlugs !== undefined) { replaceEngramTags(w, id, tagSlugs); change(`tags → ${show(tagSlugs)}`) }
      if (subjectSlugs !== undefined) { replaceEngramSubjects(w, id, subjectSlugs); change(`subjects → ${show(subjectSlugs)}`) }

      if (closing) {
        const r = closeBoundItems(w, id, newStatus as 'resolved' | 'invalidated', input.keep ?? [])
        closedWith = r.closed
        kept = r.kept
        written.push(...r.entries)
      }
      // what a reopen may bring back: the bound items that closed with it (an offer, never automatic)
      if (reopening) {
        // the supersede is undone: its edge goes, so the task can be replaced again
        this.db.prepare(`DELETE FROM relations WHERE target_id = ? AND relation = 'supersedes'`).run(id)
        reopenCandidates = closedWithTask(w, id)
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
    const w = this.write(stamp)
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
        assertNoLiveSuccessor(w, id)
        reactivatesSuperseded = successorOf(w, id) !== undefined
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
    const supersedePlan = planSupersedes(w, [...new Set(patch.supersedes ?? [])], { id, type, status: patch.status ?? existing.status })
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
      const linked = boundTaskOf(w, id)
      if (!linked) throw new Error(`Invalid engram: binding task needs a task — this ${type} is not linked to one.`)
      assertTaskOpenForBinding(w, linked.id, type)
    }
    const newStatus = patch.status ?? existing.status
    // A task-bound item closed with its task comes back with the task: reopening the
    // task lists it to reactivate. Alone it is reactivated only as a standing item.
    if ((type === 'decision' || type === 'note') && newStatus === 'active' && existing.status !== 'active' && newProps.binding === 'task') {
      const linked = boundTaskOf(w, id)
      if (linked && !(TASK_OPEN_STATUSES as readonly string[]).includes(linked.status)) {
        throw new Error(`Invalid engram: task ${linked.id} is ${linked.status} — a ${type} bound to it stays closed with it; reopen the task first (eml_track_task status planned or active lists it to reactivate), or make it standing (binding=standing) in the same call.`)
      }
    }
    // One core profile per scope: an explicit core=true replaces the current one;
    // a reactivation or a move into a scope that has one is refused, not silently retiring it.
    const coreNewlySet = newProps.core === true && oldProps.core !== true
    if (type === 'profile' && newProps.core === true && newStatus === 'active' && !coreNewlySet) {
      const arriving = existing.status !== 'active' || (patch.scope !== undefined && patch.scope !== existing.scope)
      const other = arriving ? activeCoreProfileIn(w, newScope, id) : null
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
    const tagSlugs = patch.tags !== undefined ? normalizeAndValidateTags(w, patch.tags, tagsOf(w, id)) : undefined
    const subjectSlugs = patch.subjects !== undefined ? normalizeAndValidateSubjects(w, patch.subjects) : undefined
    // a set equal to the stored one is no change (no write, no rev)
    const tagsChange = tagSlugs !== undefined && !sameSet(tagSlugs, tagsOf(w, id)) ? tagSlugs : undefined
    const subjectsChange = subjectSlugs !== undefined && !sameSet(subjectSlugs, subjectsOf(w, id)) ? subjectSlugs : undefined

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
        superseded.push(...autoSupersedeCoreProfile(w, id, newScope))
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
      if (tagsChange !== undefined) replaceEngramTags(w, id, tagsChange)
      if (subjectsChange !== undefined) replaceEngramSubjects(w, id, subjectsChange)
      if (contentChanged) wikilinks = materializeWikilinks(w, id, newContent!, newScope)
      superseded.push(...applySupersedes(w, id, supersedePlan).superseded)
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
    const w = this.write(stamp)
    const existing = this.db.prepare('SELECT * FROM engrams WHERE id = ?').get(id) as any
    if (!existing) return null
    const live = existing.type === 'task' ? (TASK_OPEN_STATUSES as readonly string[]).includes(existing.status) : existing.status === 'active'
    if (!live) throw new Error(`Invalid engram: ${id} is ${existing.status} — a review confirms an active engram${existing.type === 'task' ? ' (an open task)' : ''}.`)
    if (existing.type === 'task') {
      this.db.transaction(() => {
        this.db.prepare(`UPDATE engrams SET updated_at = ? WHERE id = ?`).run(stamp.at, id)
        bumpRev(this.db, stamp, id)
        if (text && text.trim() !== '') {
          appendEntry(this.db, id, { kind: 'note', text, stage: propsOf(w, id).stage as string ?? null }, stamp)
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
    const w = this.write(stamp)
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
    const tagSlugs = input.tags !== undefined ? normalizeAndValidateTags(w, input.tags) : undefined
    const subjectSlugs = input.subjects !== undefined ? normalizeAndValidateSubjects(w, input.subjects) : undefined
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
      if (tagSlugs && tagSlugs.length > 0) insertEngramTags(w, id, tagSlugs)
      if (subjectSlugs && subjectSlugs.length > 0) insertEngramSubjects(w, id, subjectSlugs)
      materializeWikilinks(w, id, input.content!, input.scope!)
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
    const w = this.write(stamp)
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
        const current = boundTaskOf(w, input.source_id)
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
    if (input.relation !== 'related_to') dropWikilinkEcho(w, input.source_id, input.target_id)
    return info.changes > 0
  }

}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every(x => sb.has(x))
}
