import { assertObject, checkFields } from '../objects'
import { slugifyTag } from '../tags'
import { slugifySubject } from '../subjects'
import { createProject, createEntity, createTag, updateTag, createSubject, updateSubject, createUser, createAgent, insertRunRow } from '../write/objects'
import { appendTaskChange } from '../write/task-binding'
import { isoTimestamp } from '../fields'
import type { Run } from '../runs'
import { CALL_KEYS, keyList, unknownFieldsText, unknownKeys } from '../contract/calls'
import { OBJECT_ID, HANDLE } from '../contract/values'
import { CommandError, inputObject, type CommandContext, type CommandModule } from './types'

/** object.create — `object` names the kind (an entity has a field called kind). */
export interface ObjectCreateInput {
  object: string
  fields: Record<string, unknown>
}

/** object.create — a project, entity, tag, subject, user, agent or run. Was createObject and the stores' create. */
export const objectCreate: CommandModule<ObjectCreateInput, { object: unknown, created: boolean }> = {
  name: 'object.create',
  validate(input) {
    const o = inputObject('object.create', input)
    const unknown = unknownKeys(o, CALL_KEYS['object.create'])
    if (unknown.length > 0) throw new CommandError('INVALID', `Invalid command: ${unknownFieldsText(unknown)} — object.create takes ${keyList(CALL_KEYS['object.create'])}.`)
    if (!o.fields || typeof o.fields !== 'object' || Array.isArray(o.fields)) throw new CommandError('INVALID', 'Invalid object: fields must be an object.')
    return o as unknown as ObjectCreateInput
  },
  apply(ctx, input) {
    return createObject(ctx, input.object, input.fields)
  },
}

/**
 * Create an object; only the kind's fields. A project's, entity's, user's or
 * agent's id defaults to the slug of its name. v0.20: the apply of the
 * object.create command, inside its transaction, with the write's timestamp.
 */
function createObject(ctx: CommandContext, object: unknown, input: Record<string, unknown>): { object: unknown, created: boolean } {
  assertObject(object)
  checkFields(object, input, 'create')
  if (object === 'run') return { object: createRun(ctx, input), created: true }
  if (typeof input.name !== 'string' || input.name.trim() === '') throw new Error(`Invalid object: a ${object} needs a name.`)
  const name = input.name.trim()
  const idOf = (what: string) => {
    const id = (input.id as string | undefined) ?? slugifyTag(name)
    if (!OBJECT_ID.test(id)) throw new Error(`Invalid object: ${what} id is letters, digits, - and _ (it becomes the scope ${object}.<id>).`)
    return id
  }
  switch (object) {
    case 'project': {
      const id = idOf('a project')
      if (ctx.eml.projects.exists(id)) throw new Error(`Invalid object: project "${id}" already exists.`)
      if (input.status === 'archived') throw new Error('Invalid object: a new project is active or paused.')
      const project = createProject(ctx, {
        id, name, status: input.status as 'active' | undefined, goal: input.goal as string | undefined,
        description: input.description as string | undefined, owner: input.owner as string | undefined,
        parent_project: input.parent_project as string | undefined, started_at: input.started_at as string | undefined,
        status_tracks: input.status_tracks as string | undefined, metadata: input.metadata as Record<string, string> | undefined,
      })
      return { object: project, created: true }
    }
    case 'entity': {
      const id = idOf('an entity')
      if (!input.kind) throw new Error('Invalid object: an entity needs kind — person, org or asset.')
      if (ctx.eml.entities.exists(id)) throw new Error(`Invalid object: entity "${id}" already exists.`)
      const entity = createEntity(ctx, {
        id, name, kind: input.kind as 'person', status: input.status as 'active' | undefined,
        description: input.description as string | undefined, status_tracks: input.status_tracks as string | undefined,
        metadata: input.metadata as Record<string, string> | undefined,
      })
      return { object: entity, created: true }
    }
    case 'tag': {
      const created = !ctx.eml.tags.exists(slugifyTag(name))
      const tag = createTag(ctx, { name, description: input.description as string | undefined })
      if (created && input.status === 'archived') updateTag(ctx, tag.id, { status: 'archived' })
      return { object: ctx.eml.tags.get(tag.id), created }
    }
    case 'subject': {
      const created = !ctx.eml.subjects.exists(slugifySubject(name))
      const subject = createSubject(ctx, { name, description: input.description as string | undefined })
      if (created && input.status === 'closed') updateSubject(ctx, subject.id, { status: 'closed' })
      return { object: ctx.eml.subjects.get(subject.id), created }
    }
    case 'user': {
      const id = idOf('a user')
      if (ctx.eml.users.exists(id)) throw new Error(`Invalid object: user "${id}" already exists.`)
      const user = createUser(ctx, {
        id, name, email: input.email as string | undefined, description: input.description as string | undefined,
        metadata: input.metadata as Record<string, string> | undefined,
      })
      return { object: user, created: true }
    }
    case 'agent': {
      const id = idOf('an agent')
      if (ctx.eml.agents.exists(id)) throw new Error(`Invalid object: agent "${id}" already exists.`)
      const agent = createAgent(ctx, {
        id, name, parent_id: input.parent_id as string | undefined, domains: input.domains as string[] | undefined,
        description: input.description as string | undefined, metadata: input.metadata as Record<string, string> | undefined,
      })
      return { object: agent, created: true }
    }
  }
}

/**
 * v0.23: a run — one session on a task (runs.ts). Its id is the session id;
 * task_id names a task of this brain; member is the writer's own handle
 * (in a shared brain the op's author, so a member starts runs only for
 * themself); origin and driver say who started it and who drives it. state
 * defaults to running, started_at to the write's time. The start is journaled
 * on the task.
 */
function createRun(ctx: CommandContext, input: Record<string, unknown>): Run {
  const problems: string[] = []
  for (const k of ['id', 'task_id', 'member', 'origin', 'driver'] as const) {
    if (typeof input[k] !== 'string' || (input[k] as string).trim() === '') problems.push(`a run needs ${k}.`)
  }
  if (problems.length > 0) throw new Error(`Invalid object: ${problems.join(' ')}`)
  const id = input.id as string
  if (!OBJECT_ID.test(id)) throw new Error('Invalid object: a run id is letters, digits, - and _ (the session id).')
  const handle = ctx.stamp.actor.handle
  if (handle === null) throw new Error('Invalid object: a run is written by its member — this write has no handle.')
  if (input.member !== handle) throw new Error(`Invalid object: a run's member is the member who writes it (${handle}), not ${String(input.member)}.`)
  if (input.agent !== undefined && input.agent !== null && !HANDLE.test(input.agent as string)) {
    throw new Error('Invalid object: a run\'s agent is 1–63 characters of a-z, 0-9, _ and -.')
  }
  const task = ctx.db.prepare('SELECT type FROM engrams WHERE id = ?').get(input.task_id) as { type: string } | undefined
  if (task?.type !== 'task') throw new Error(`Invalid object: task_id ${String(input.task_id)} is not a task of this brain.`)
  if (ctx.eml.runs.exists(id)) throw new Error(`Invalid object: run "${id}" already exists.`)
  const at = ctx.stamp.at
  const ts = (k: string) => typeof input[k] === 'string' ? isoTimestamp(input[k] as string) : null
  const run: Run = {
    id, task_id: input.task_id as string, member: handle, agent: (input.agent as string | undefined) ?? null,
    origin: input.origin as Run['origin'], driver: input.driver as Run['driver'],
    state: (input.state as Run['state'] | undefined) ?? 'running',
    started_at: ts('started_at') ?? at, heartbeat_at: ts('heartbeat_at'), lease_until: ts('lease_until'),
    created_at: at, updated_at: at,
  }
  insertRunRow(ctx.db, run)
  appendTaskChange(ctx, run.task_id, `run ${id} started (${run.origin}, ${run.driver}${run.agent ? `, ${run.agent}` : ''})${run.state === 'ended' ? ' and ended' : ''}`)
  return ctx.eml.runs.get(id)!
}
