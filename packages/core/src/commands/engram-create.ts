import {
  TYPE_DEFAULT_STATUS, TYPE_REVIEW_DEFAULTS, TASK_LINK_RELATION,
  type EngramInput, type StoredEngram, type EngramStatus, type OpenSubtask,
} from '../types'
import type { LearningState } from '../learning'
import { validateEngramType, validateFormat, validateNoTemplateLeak } from '../validate'
import { ORIGINS, SEED_ORIGIN, validateFields, normalizeTimestampFields, fieldProblem, unknownFieldsError, isBlank } from '../fields'
import { appendEntry } from '../entries'
import { addDays } from '../env'
import { renderLogContent, CONFLICT_TYPES, STORE_INPUT_KEYS, createInputKeys } from '../engrams'
import { validateScope } from '../write/scope'
import { planSupersedes, applySupersedes, supersede, activeStatusState, autoSupersedeCoreProfile, autoSupersedeStatusEngrams } from '../write/supersede'
import { normalizeAndValidateTags, normalizeAndValidateSubjects, insertEngramTags, insertEngramSubjects } from '../write/tags-subjects'
import { materializeWikilinks } from '../write/wikilinks'
import { assertTaskOpenForBinding, linkPartOf, appendTaskChange } from '../write/task-binding'
import { findPotentialConflicts } from '../write/conflicts'
import { CommandError, inputObject, type CommandContext, type CommandModule } from './types'
import { createLearning } from './learning'

/** engram.create for a learning: the lesson and its first evidence (the topic check runs first). */
export interface LearningCreateInput {
  type: 'learning'
  scope: string
  title: string
  content: string
  tags?: string[]
  subjects?: string[]
  new_topic?: boolean
  evidence: { source: string, happened: string, quote?: string, stance?: string, rule_id?: string }
}

export type EngramCreateInput = EngramInput | LearningCreateInput
export type EngramCreateResult = StoredEngram & { learning?: LearningState }

/** engram.create — a new engram of any type. Was EngramStore.store and the create half of learn. */
export const engramCreate: CommandModule<EngramCreateInput, EngramCreateResult> = {
  name: 'engram.create',
  validate(input) {
    const o = inputObject('engram.create', input)
    if (typeof o.type !== 'string') throw new CommandError('INVALID', 'Invalid engram: type is required.')
    if (o.type === 'learning') {
      const e = o.evidence
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        throw new CommandError('INVALID', 'Invalid engram: a learning is written with eml_learning, which checks the topic first.')
      }
    }
    return o as unknown as EngramCreateInput
  },
  apply(ctx, input) {
    if (input.type !== 'learning') return store(ctx, input as EngramInput)
    const { type: _type, evidence, ...lesson } = input as LearningCreateInput
    const r = createLearning(ctx, { ...lesson, ...evidence })
    if (!r.written) {
      throw new CommandError('TOPIC_EXISTS',
        'Invalid engram: an active learning on this topic exists — add the incident to it (learning.add_evidence with its id), or pass new_topic for a different topic.',
        { matches: r.matches })
    }
    return { ...r.engram, learning: r.learning } as EngramCreateResult
  },
}

/**
 * v0.19: create an engram of any type except learning (createLearning) — the one
 * write path for MCP, REST and CLI. Strict: the input may carry only the
 * universal fields and the type's own fields (fields.ts); every rule of the
 * type is checked here, so no surface can skip it. Provenance comes from the
 * env's actor. Errors start with `Invalid engram:`.
 */
function store(ctx: CommandContext, input: EngramInput): StoredEngram {
  const { db, stamp } = ctx
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
    const target = db.prepare('SELECT type FROM engrams WHERE id = ?').get(input.task_id) as { type: string } | undefined
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
    if (props.binding === 'task') assertTaskOpenForBinding(ctx, input.task_id!, type)
  }
  if (type === 'profile' && !/^(agent|user|entity)\./.test(input.scope)) {
    throw new Error('Invalid engram: a profile is about someone — scope agent.<id>, user.<id> or entity.<id>.')
  }
  if (input.from_learning !== undefined && type !== 'rule') {
    throw new Error('Invalid engram: from_learning is only for a rule that grows from learnings.')
  }
  const fromLearning = input.from_learning ?? []
  for (const lid of fromLearning) {
    const l = db.prepare('SELECT type, status FROM engrams WHERE id = ?').get(lid) as { type: string, status: string } | undefined
    if (l?.type !== 'learning') throw new Error(`Invalid engram: from_learning ${lid} is not a learning.`)
    if (l.status !== 'active') throw new Error(`Invalid engram: learning ${lid} is ${l.status}, not active.`)
  }
  const supersedePlan = planSupersedes(ctx, [...new Set(input.supersedes ?? [])], { id: null, type, status, parentId: input.parent_id })

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
    const existing = ctx.store.sessionLog(actor.session_id)
    if (existing) {
      throw new Error(
        `Invalid engram: this session already has a log (${existing.id} ${existing.title ?? ''}) — update it with eml_update.`.replace(' )', ')'),
      )
    }
    content = renderLogContent(props, input.content ?? '')
  }

  validateScope(ctx, input.scope)
  const tagSlugs = input.tags !== undefined ? normalizeAndValidateTags(ctx, input.tags) : undefined
  const subjectSlugs = input.subjects !== undefined ? normalizeAndValidateSubjects(ctx, input.subjects) : undefined

  const id = stamp.newId()
  const now = stamp.at
  let wikilinks: { resolved: string[]; unresolved: string[] } = { resolved: [], unresolved: [] }
  const openSubtasks: OpenSubtask[] = []
  const superseded: string[] = []
  let previousState: string | null | undefined

  // One transaction: the row, its search entry, every edge and entry it draws.
  // ingested_by is the caller the server derived from the token — never input.
  db.transaction(() => {
    // One core profile per scope (unique index): the old one goes first.
    stamp.created.add(id)
    if (type === 'profile' && props.core === true) superseded.push(...autoSupersedeCoreProfile(ctx, id, input.scope))
    db.prepare(`
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
    db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) VALUES (?, ?, ?, ?)`)
      .run(id, content, input.scope, input.title ?? '')

    if (type === 'status') {
      previousState = activeStatusState(ctx, input.scope, id)
      superseded.push(...autoSupersedeStatusEngrams(ctx, id, input.scope))
    }
    if (type === 'task') {
      const stage = typeof props.stage === 'string' ? ` · stage ${props.stage}` : ''
      appendEntry(db, id, { kind: 'change', text: `created (${status}${stage})`, stage: (props.stage as string) ?? null }, stamp)
    }

    const replaced = applySupersedes(ctx, id, supersedePlan)
    superseded.push(...replaced.superseded)
    openSubtasks.push(...replaced.openSubtasks)
    for (const lid of fromLearning) {
      supersede(ctx, id, lid)
      superseded.push(lid)
    }

    if (input.parent_id !== undefined) linkPartOf(ctx, id, input.parent_id)

    // A task-linked write: edge to the task + a change entry in its journal.
    if (input.task_id !== undefined && taskLink) {
      db.prepare(`
        INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, created_at)
        VALUES (?, ?, ?, ?, 'agent_declared', 1.0, ?)
        ON CONFLICT(source_id, target_id, relation) DO NOTHING
      `).run(stamp.newId(), id, input.task_id, taskLink, stamp.at)
      const label = input.title ?? (input.content.length > 80 ? `${input.content.slice(0, 80)}…` : input.content)
      const verb = type === 'decision' ? 'taken' : type === 'event' ? 'recorded' : 'written'
      appendTaskChange(ctx, input.task_id, `${type} ${verb}: ${label} (${id})`)
    }

    if (tagSlugs && tagSlugs.length > 0) insertEngramTags(ctx, id, tagSlugs)
    if (subjectSlugs && subjectSlugs.length > 0) insertEngramSubjects(ctx, id, subjectSlugs)
    wikilinks = materializeWikilinks(ctx, id, content, input.scope)
  })()

  if (wikilinks.unresolved.length > 0) {
    console.warn(`[EML] unresolved wikilink(s) in engram ${id}: ${wikilinks.unresolved.map(t => `[[${t}]]`).join(' ')}`)
  }

  const stored = ctx.store.getRaw(id, stamp.at)!
  const extra: Partial<StoredEngram> = {}
  if (wikilinks.unresolved.length > 0) extra.unresolved_links = wikilinks.unresolved
  if (openSubtasks.length > 0) extra.open_subtasks = openSubtasks
  if (superseded.length > 0) extra.superseded = superseded
  if (type === 'status') {
    extra.previous_state = previousState ?? null
    const tracks = ctx.store.statusTracksOf(input.scope)
    if (tracks.hasObject) {
      extra.status_tracks = tracks.value
      if (tracks.value === null) extra.status_tracks_missing = true
    }
  }
  if (CONFLICT_TYPES.has(type)) {
    const potential_conflicts = findPotentialConflicts(ctx, stored)
    if (potential_conflicts.length > 0) extra.potential_conflicts = potential_conflicts
  }
  return { ...stored, ...extra }
}
