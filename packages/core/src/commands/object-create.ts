import { createObject } from '../objects'
import { CommandError, inputObject, type CommandModule } from './types'

/** object.create — `object` names the kind (an entity has a field called kind). */
export interface ObjectCreateInput {
  object: string
  fields: Record<string, unknown>
}

/** object.create — a project, entity, tag, subject, user or agent. Was createObject and the stores' create. */
export const objectCreate: CommandModule<ObjectCreateInput, { object: unknown, created: boolean }> = {
  name: 'object.create',
  validate(input) {
    const o = inputObject('object.create', input)
    if (!o.fields || typeof o.fields !== 'object' || Array.isArray(o.fields)) throw new CommandError('INVALID', 'Invalid object: fields must be an object.')
    return o as unknown as ObjectCreateInput
  },
  apply(ctx, input, stamp) {
    return createObject(ctx.eml, ctx.objects, input.object, input.fields, stamp.at)
  },
}
