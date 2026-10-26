import { TYPE_REVIEW_DEFAULTS, TASK_OPEN_STATUSES, type EngramType, type StoredEngram } from '../types'
import { validateFormat, validateNoTemplateLeak } from '../validate'
import { TYPE_FIELDS, validateFields, normalizeTimestampFields, fieldProblem, unknownFieldsError, isBlank } from '../fields'
import { appendEntry, bumpRev } from '../entries'
import { learningState, LEARNING_SHARPENED } from '../learning'
import { addDays } from '../env'
import { REVIEWABLE_TYPES } from '../review-due'
import { renderLogContent, hasStartHere, UPDATE_PATCH_KEYS, LEARNING_CONTENT_MAX_CHARS, type EngramPatch } from '../engrams'
import { validateScope } from '../write/scope'
import { planSupersedes, applySupersedes, successorOf, assertNoLiveSuccessor, activeCoreProfileIn, autoSupersedeCoreProfile } from '../write/supersede'
import { normalizeAndValidateTags, normalizeAndValidateSubjects, tagsOf, subjectsOf, replaceEngramTags, replaceEngramSubjects, sameSet } from '../write/tags-subjects'
import { materializeWikilinks } from '../write/wikilinks'
import { boundTaskOf, assertTaskOpenForBinding } from '../write/task-binding'
import { CommandError, assertBaseRev, checkBaseRev, inputObject, requireText, type CommandContext, type CommandModule } from './types'

/** engram.update — the /update body: the engram and its patch (flat fields already split into properties). */
export interface EngramUpdateInput {
  id: string
  patch: EngramPatch
  /** Optional precondition: the rev the caller read (cockpit, sync; not MCP). */
  base_rev?: number
}

/** engram.update — correct or retire an engram that is not a task. Was EngramStore.update. */
export const engramUpdate: CommandModule<EngramUpdateInput, StoredEngram> = {
  name: 'engram.update',
  validate(input) {
    const o = inputObject('engram.update', input)
    requireText(o, 'id', 'Invalid engram: id is required.')
    if (!o.patch || typeof o.patch !== 'object' || Array.isArray(o.patch)) throw new CommandError('INVALID', 'Invalid engram: patch must be an object.')
    checkBaseRev(o)
    return o as unknown as EngramUpdateInput
  },
  apply(ctx, input) {
    assertBaseRev(ctx, input.id, input.base_rev)
    const r = update(ctx, input.id, input.patch)
    if (!r) throw new CommandError('NOT_FOUND', 'engram not found')
    return r
  },
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
function update(ctx: CommandContext, id: string, patch: EngramPatch): StoredEngram | null {
  const { db, stamp } = ctx
  const actor = stamp.actor
  const existing = db.prepare('SELECT * FROM engrams WHERE id = ?').get(id) as any
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
      assertNoLiveSuccessor(ctx, id)
      reactivatesSuperseded = successorOf(ctx, id) !== undefined
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
  const supersedePlan = planSupersedes(ctx, [...new Set(patch.supersedes ?? [])], { id, type, status: patch.status ?? existing.status })
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
    const linked = boundTaskOf(ctx, id)
    if (!linked) throw new Error(`Invalid engram: binding task needs a task — this ${type} is not linked to one.`)
    assertTaskOpenForBinding(ctx, linked.id, type)
  }
  const newStatus = patch.status ?? existing.status
  // A task-bound item closed with its task comes back with the task: reopening the
  // task lists it to reactivate. Alone it is reactivated only as a standing item.
  if ((type === 'decision' || type === 'note') && newStatus === 'active' && existing.status !== 'active' && newProps.binding === 'task') {
    const linked = boundTaskOf(ctx, id)
    if (linked && !(TASK_OPEN_STATUSES as readonly string[]).includes(linked.status)) {
      throw new Error(`Invalid engram: task ${linked.id} is ${linked.status} — a ${type} bound to it stays closed with it; reopen the task first (eml_track_task status planned or active lists it to reactivate), or make it standing (binding=standing) in the same call.`)
    }
  }
  // One core profile per scope: an explicit core=true replaces the current one;
  // a reactivation or a move into a scope that has one is refused, not silently retiring it.
  const coreNewlySet = newProps.core === true && oldProps.core !== true
  if (type === 'profile' && newProps.core === true && newStatus === 'active' && !coreNewlySet) {
    const arriving = existing.status !== 'active' || (patch.scope !== undefined && patch.scope !== existing.scope)
    const other = arriving ? activeCoreProfileIn(ctx, newScope, id) : null
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

  if (patch.scope !== undefined && patch.scope !== existing.scope) validateScope(ctx, patch.scope)
  const tagSlugs = patch.tags !== undefined ? normalizeAndValidateTags(ctx, patch.tags, tagsOf(ctx, id)) : undefined
  const subjectSlugs = patch.subjects !== undefined ? normalizeAndValidateSubjects(ctx, patch.subjects) : undefined
  // a set equal to the stored one is no change (no write, no rev)
  const tagsChange = tagSlugs !== undefined && !sameSet(tagSlugs, tagsOf(ctx, id)) ? tagSlugs : undefined
  const subjectsChange = subjectSlugs !== undefined && !sameSet(subjectSlugs, subjectsOf(ctx, id)) ? subjectSlugs : undefined

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
  if (type === 'profile' && newProps.core === true && oldProps.core !== true && newStatus === 'active') {
    superseded.push(...autoSupersedeCoreProfile(ctx, id, newScope))
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
    db.prepare(`UPDATE engrams SET ${sets.join(', ')} WHERE id = ?`).run(...params, stamp.at, id)
    bumpRev(db, stamp, id)
  }
  if (contentChanged || scopeChanged || titleChanged) {
    db.prepare('DELETE FROM engrams_fts WHERE id = ?').run(id)
    db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) SELECT id, content, scope, COALESCE(title, '') FROM engrams WHERE id = ?`).run(id)
  }
  if (tagsChange !== undefined) replaceEngramTags(ctx, id, tagsChange)
  if (subjectsChange !== undefined) replaceEngramSubjects(ctx, id, subjectsChange)
  if (contentChanged) wikilinks = materializeWikilinks(ctx, id, newContent!, newScope)
  superseded.push(...applySupersedes(ctx, id, supersedePlan).superseded)
  if (patch.review_note !== undefined) appendEntry(db, id, { kind: 'review', text: patch.review_note }, stamp)
  // a decision's or note's status change goes into its journal (a reopen of its task reads the last one)
  if ((type === 'decision' || type === 'note') && newStatus !== existing.status) {
    appendEntry(db, id, { kind: 'change', text: `status ${existing.status} → ${newStatus}` }, stamp)
  }
  // the supersede is undone: its edge goes, so the engram can be superseded again
  if (reactivatesSuperseded) db.prepare(`DELETE FROM relations WHERE target_id = ? AND relation = 'supersedes'`).run(id)
  if (logCorrection) appendEntry(db, id, { kind: 'change', text: logCorrection }, stamp)
  if (type === 'learning' && patch.content !== undefined && patch.content !== existing.content) {
    appendEntry(db, id, { kind: 'change', text: LEARNING_SHARPENED }, stamp)
  }

  if (wikilinks.unresolved.length > 0) {
    console.warn(`[EML] unresolved wikilink(s) in engram ${id}: ${wikilinks.unresolved.map(t => `[[${t}]]`).join(' ')}`)
  }

  const updated = ctx.store.getRaw(id, stamp.at)!
  return {
    ...updated,
    diff,
    ...(superseded.length > 0 ? { superseded } : {}),
    ...(wikilinks.unresolved.length > 0 ? { unresolved_links: wikilinks.unresolved } : {}),
    ...(type === 'learning' ? { learning: learningState(ctx.store.entries(id)) } : {}),
  }
}
