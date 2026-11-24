import { assertObject, checkFields, diffOf } from '../objects'
import { slugifyTag } from '../tags'
import { updateProject, updateEntity, updateTag, updateSubject, updateUser, updateAgent, updateRunRow, type RunPatch } from '../write/objects'
import type { Run } from '../runs'
import { appendTaskChange } from '../write/task-binding'
import { isoTimestamp } from '../fields'
import { HANDLE } from '../contract/values'
import { CALL_KEYS, keyList, unknownFieldsText, unknownKeys } from '../contract/calls'
import { CommandError, inputObject, requireText, type CommandContext, type CommandModule } from './types'

/** object.update — the kind, the object's id and the patch. */
export interface ObjectUpdateInput {
  object: string
  id: string
  patch: Record<string, unknown>
}

/** object.update — a project, entity, tag, subject, user, agent or run. Was updateObject and the stores' update. */
export const objectUpdate: CommandModule<ObjectUpdateInput, { object: unknown, diff: Record<string, [unknown, unknown]> }> = {
  name: 'object.update',
  validate(input) {
    const o = inputObject('object.update', input)
    const unknown = unknownKeys(o, CALL_KEYS['object.update'])
    if (unknown.length > 0) throw new CommandError('INVALID', `Invalid command: ${unknownFieldsText(unknown)} — object.update takes ${keyList(CALL_KEYS['object.update'])}.`)
    requireText(o, 'id', 'Invalid object: id is required.')
    if (!o.patch || typeof o.patch !== 'object' || Array.isArray(o.patch)) throw new CommandError('INVALID', 'Invalid object: patch must be an object.')
    return o as unknown as ObjectUpdateInput
  },
  apply(ctx, input) {
    const r = updateObject(ctx, input.object, input.id, input.patch)
    if (!r) throw new CommandError('NOT_FOUND', `${input.object} "${input.id}" not found`)
    return r
  },
}

/**
 * Update an object; only the kind's fields; null clears an optional one.
 * Returns the object and the diff, or null for an unknown id. v0.20: the apply
 * of the object.update command, with the write's timestamp.
 */
function updateObject(ctx: CommandContext, object: unknown, id: string, patch: Record<string, unknown>): { object: unknown, diff: Record<string, [unknown, unknown]> } | null {
  assertObject(object)
  checkFields(object, patch, 'update')
  switch (object) {
    case 'project': {
      const before = ctx.eml.projects.get(id)
      if (!before) return null
      // archiving sets ended_at; leaving archived clears it
      const ended = patch.status === 'archived' && before.status !== 'archived' ? ctx.stamp.at.slice(0, 10)
        : patch.status !== undefined && patch.status !== 'archived' && before.status === 'archived' ? null : undefined
      const after = updateProject(ctx, id, {
        ...(patch as object),
        ...(ended !== undefined ? { ended_at: ended as string } : {}),
      } as never)!
      return { object: after, diff: diffOf(before as never, after as never) }
    }
    case 'entity': {
      const before = ctx.eml.entities.get(id)
      if (!before) return null
      const after = updateEntity(ctx, id, patch as never)!
      return { object: after, diff: diffOf(before as never, after as never) }
    }
    case 'tag': {
      const slug = slugifyTag(id)
      const before = ctx.eml.tags.get(slug)
      if (!before) return null
      const after = updateTag(ctx, slug, patch as never)!
      return { object: after, diff: diffOf(before as never, after as never) }
    }
    case 'subject': {
      const before = ctx.eml.subjects.get(id)
      if (!before) return null
      const after = updateSubject(ctx, id, patch as never)
      return { object: after, diff: diffOf(before as never, after as never) }
    }
    case 'user': {
      const before = ctx.eml.users.get(id)
      if (!before) return null
      const after = updateUser(ctx, id, patch as never)!
      return { object: after, diff: diffOf(before as never, after as never) }
    }
    case 'agent': {
      const before = ctx.eml.agents.get(id)
      if (!before) return null
      const after = updateAgent(ctx, id, patch as never)!
      return { object: after, diff: diffOf(before as never, after as never) }
    }
    case 'run': {
      const before = ctx.eml.runs.get(id)
      if (!before) return null
      // v0.23: only the member a run names changes it — every replica refuses another member's op
      if (ctx.stamp.actor.handle !== before.member) {
        throw new Error(`Invalid object: only its member ${before.member} changes run ${id}.`)
      }
      if (typeof patch.agent === 'string' && !HANDLE.test(patch.agent)) throw new Error('Invalid object: a run\'s agent is 1–63 characters of a-z, 0-9, _ and -.')
      // every write of a run is something that happened: it is its last activity unless the patch says when.
      // Ending sets ended_at (the write's time unless given); a resume clears ended_at and end_reason.
      const ts = (k: string) => typeof patch[k] === 'string' ? isoTimestamp(patch[k] as string) : undefined
      const state = (patch.state as Run['state'] | undefined) ?? before.state
      if (state !== 'ended' && patch.end_reason != null) throw new Error('Invalid object: end_reason is for an ended run.')
      if (state !== 'ended' && patch.ended_at != null) throw new Error('Invalid object: ended_at is for an ended run.')
      if (patch.last_activity_at === null) throw new Error('Invalid object: last_activity_at cannot be cleared.')
      const ending = before.state !== 'ended' && state === 'ended'
      const resuming = before.state === 'ended' && state !== 'ended'
      const runPatch: RunPatch = {
        agent: patch.agent as string | null | undefined, driver: patch.driver as never, state: patch.state as never,
        last_activity_at: ts('last_activity_at') ?? ctx.stamp.at,
        result: patch.result as string | null | undefined,
        end_reason: resuming ? null : patch.end_reason as never,
        ended_at: resuming ? null : (ts('ended_at') ?? (ending ? ctx.stamp.at : undefined)),
      }
      updateRunRow(ctx, id, runPatch)
      const after = ctx.eml.runs.get(id)!
      // its end (and a resume after it) is journaled on its task; the other states change often and are not
      // (unless the task has left this brain since)
      const journaled = !!ctx.db.prepare('SELECT 1 FROM engrams WHERE id = ?').get(after.task_id)
      if (journaled && ending) appendTaskChange(ctx, after.task_id, `run ${id} ended${after.end_reason ? ` (${after.end_reason})` : ''}`)
      if (journaled && resuming) appendTaskChange(ctx, after.task_id, `run ${id} resumed`)
      return { object: after, diff: diffOf(before as never, after as never) }
    }
  }
}
