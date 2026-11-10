import { assertObject, checkFields, diffOf } from '../objects'
import { slugifyTag } from '../tags'
import { updateProject, updateEntity, updateTag, updateSubject, updateUser, updateAgent } from '../write/objects'
import { CommandError, inputObject, requireText, type CommandContext, type CommandModule } from './types'

/** object.update — the kind, the object's id and the patch. */
export interface ObjectUpdateInput {
  object: string
  id: string
  patch: Record<string, unknown>
}

/** object.update — a project, entity, tag, subject, user or agent. Was updateObject and the stores' update. */
export const objectUpdate: CommandModule<ObjectUpdateInput, { object: unknown, diff: Record<string, [unknown, unknown]> }> = {
  name: 'object.update',
  validate(input) {
    const o = inputObject('object.update', input)
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
  }
}
