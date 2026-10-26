import { TASK_OPEN_STATUSES, type StoredEngram, type EngramStatus, type OpenSubtask, type BoundItem } from '../types'
import { validateNoTemplateLeak } from '../validate'
import { validateFields, unknownFieldsError, isBlank } from '../fields'
import { appendEntry, bumpRev, type Entry } from '../entries'
import { CLOSED_WITH_TASK, TRACK_TASK_KEYS, type TrackTaskInput } from '../engrams'
import { validateScope } from '../write/scope'
import { planSupersedes, applySupersedes, liveSuccessorOf, assertNoLiveSuccessor } from '../write/supersede'
import { normalizeAndValidateTags, normalizeAndValidateSubjects, tagsOf, replaceEngramTags, replaceEngramSubjects } from '../write/tags-subjects'
import { materializeWikilinks } from '../write/wikilinks'
import { assertPartOf, linkPartOf, parentOf, openSubtasksOf, appendTaskChange, closeBoundItems } from '../write/task-binding'
import { CommandError, assertBaseRev, checkBaseRev, inputObject, requireText, type CommandContext, type CommandModule } from './types'

/** task.track — the /task/:id/track body plus the task's id; base_rev is an optional precondition (cockpit, sync; not MCP). */
export type TaskTrackInput = TrackTaskInput & { id: string, base_rev?: number }

/** task.track — everything that happens to an existing task. Was EngramStore.trackTask. */
export const taskTrack: CommandModule<TaskTrackInput, StoredEngram> = {
  name: 'task.track',
  validate(input) {
    const o = inputObject('task.track', input)
    requireText(o, 'id', 'Invalid engram: id is required (the task).')
    checkBaseRev(o)
    return o as unknown as TaskTrackInput
  },
  apply(ctx, input) {
    const { id, base_rev, ...track } = input
    assertBaseRev(ctx, id, base_rev)
    const r = trackTask(ctx, id, track)
    if (!r) throw new CommandError('NOT_FOUND', 'task not found')
    return r
  },
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
function trackTask(ctx: CommandContext, id: string, input: TrackTaskInput): StoredEngram | null {
  const { db, stamp } = ctx
  const existing = db.prepare('SELECT * FROM engrams WHERE id = ?').get(id) as any
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
  if (reopening) assertNoLiveSuccessor(ctx, id)
  // closed → closed is not a close: the outcome changes by reopening and closing
  // again (both in the journal). The current status repeated without an outcome
  // is a no-op. Checked before the field rules, so the answer names the state.
  const closesAgain = input.status !== undefined && !wasOpen && existing.status !== 'superseded'
    && (input.status === 'resolved' || input.status === 'invalidated')
    && (input.status !== existing.status || input.outcome !== undefined)
  if (closesAgain) {
    throw new Error(`Invalid engram: task ${id} is already ${existing.status} — to change how it ended, reopen it (status planned or active) and close it again.`)
  }
  const supersedePlan = planSupersedes(ctx, [...new Set(input.supersedes ?? [])], { id, type: 'task', status: newStatus, parentId: input.parent_id })
  if (input.scope !== undefined && input.scope !== existing.scope) validateScope(ctx, input.scope)

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
    const open = openSubtasksOf(ctx, id)
    if (open.length > 0) {
      throw new Error(`Invalid engram: task ${id} has open sub-tasks: ${open.map(c => `${c.id} ${c.title ?? '(no title)'}`).join(', ')} — close each or move it (eml_track_task(<sub-task id>, parent_id=…)) first.`)
    }
  }
  if (closing) {
    const bound = ctx.store.boundItems(id)
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
  if (input.parent_id !== undefined && input.parent_id !== null) assertPartOf(ctx, id, input.parent_id, { reparent: true })
  const tagSlugs = input.tags !== undefined ? normalizeAndValidateTags(ctx, input.tags, tagsOf(ctx, id)) : undefined
  const subjectSlugs = input.subjects !== undefined ? normalizeAndValidateSubjects(ctx, input.subjects) : undefined

  const written: Entry[] = []
  let closedWith: BoundItem[] = []
  let kept: BoundItem[] = []
  let reopenCandidates: BoundItem[] = []
  const openSubtasks: OpenSubtask[] = []
  const superseded: string[] = []
  let wikilinks: { resolved: string[]; unresolved: string[] } = { resolved: [], unresolved: [] }
  const scopeChanged = input.scope !== undefined && input.scope !== existing.scope
  db.transaction(() => {
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
    db.prepare(`UPDATE engrams SET ${sets.join(', ')} WHERE id = ?`).run(...params, stamp.at, id)
    bumpRev(db, stamp, id)
    if (input.content !== undefined || input.title !== undefined || scopeChanged) {
      db.prepare('DELETE FROM engrams_fts WHERE id = ?').run(id)
      db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) SELECT id, content, scope, COALESCE(title, '') FROM engrams WHERE id = ?`).run(id)
    }
    if (contentChanged) wikilinks = materializeWikilinks(ctx, id, input.content!, input.scope ?? existing.scope)

    if (text) written.push(appendEntry(db, id, { kind: 'note', text, stage: props.stage ?? null }, stamp))
    const change = (t: string) => written.push(appendTaskChange(ctx, id, t))
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
    const replaced = applySupersedes(ctx, id, supersedePlan)
    superseded.push(...replaced.superseded)
    openSubtasks.push(...replaced.openSubtasks)

    if (input.parent_id !== undefined) {
      const current = parentOf(ctx, id)
      if ((input.parent_id ?? undefined) !== current) {
        if (current !== undefined) db.prepare(`DELETE FROM relations WHERE source_id = ? AND relation = 'part_of'`).run(id)
        if (input.parent_id !== null) linkPartOf(ctx, id, input.parent_id)
        change(`parent ${current ?? 'none'} → ${input.parent_id ?? 'none'}`)
      }
    }
    if (tagSlugs !== undefined) { replaceEngramTags(ctx, id, tagSlugs); change(`tags → ${show(tagSlugs)}`) }
    if (subjectSlugs !== undefined) { replaceEngramSubjects(ctx, id, subjectSlugs); change(`subjects → ${show(subjectSlugs)}`) }

    if (closing) {
      const r = closeBoundItems(ctx, id, newStatus as 'resolved' | 'invalidated', input.keep ?? [])
      closedWith = r.closed
      kept = r.kept
      written.push(...r.entries)
    }
    // what a reopen may bring back: the bound items that closed with it (an offer, never automatic)
    if (reopening) {
      // the supersede is undone: its edge goes, so the task can be replaced again
      db.prepare(`DELETE FROM relations WHERE target_id = ? AND relation = 'supersedes'`).run(id)
      reopenCandidates = closedWithTask(ctx, id)
    }
  })()

  if (wikilinks.unresolved.length > 0) {
    console.warn(`[EML] unresolved wikilink(s) in engram ${id}: ${wikilinks.unresolved.map(t => `[[${t}]]`).join(' ')}`)
  }
  const updated = ctx.store.getRaw(id, stamp.at)!
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
function closedWithTask(ctx: CommandContext, taskId: string): BoundItem[] {
  const marker = `${CLOSED_WITH_TASK} ${taskId}`
  return ctx.store.boundItems(taskId, ['resolved', 'invalidated']).filter(item => {
    if (liveSuccessorOf(ctx, item.id) !== undefined) return false  // replaced since: its successor holds
    const changes = ctx.store.entries(item.id, ['change'])
    return changes[changes.length - 1]?.text === marker
  })
}
