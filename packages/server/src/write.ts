import { CommandError, knownAssignees, spacePeople, type CommandMap, type CommandName, type EML, type Env, type SpaceMember } from '@engramprotocol/core'
import type { Sync } from './sync/sync'

/**
 * The server's one write seam (v0.21, spec team-brain-sync-client-spec §4).
 * Every write route runs its command here. A private brain writes directly
 * (eml.apply). A shared brain is written through its relay (`sync`, a
 * confirmed write); without a live connection it is read-only. A brain whose
 * team file exists but cannot be used (`sync` an Error) is shared and
 * read-only until the user fixes it. A brain without a genesis — an empty
 * brain only /team/create or /team/join act on — takes no write either. A
 * brain a project move holds (`moving`, move.ts) refuses the write at once,
 * before it would wait on the move's lock.
 */
export async function applyWrite<N extends CommandName>(eml: EML, command: { name: N, input: CommandMap[N][0] }, env: Env, sync: Sync | Error | undefined, moving = false): Promise<CommandMap[N][1]> {
  if (moving) throw busy()
  if (sync instanceof Error) throw readOnly(`it stopped: its team file cannot be used (${sync.message})`, true)
  checkAssignees(eml, command, env, sync)
  checkDelegate(eml, command, env, sync)
  checkAgentTask(eml, command, env, sync)
  if (sync) return await sync.write(command, env) as CommandMap[N][1]
  // a brain with a sync is shared even before its genesis arrived from the relay
  if (eml.teamBrain() !== null) throw readOnly('it is not connected to its relay')
  if (!eml.hasGenesis()) throw readOnly('it is not created yet')
  return eml.apply(command, env)
}

/** A write the server did not do as asked — a shared brain's refusal, a brain held by a move: its HTTP status, code and the text the caller reads. */
export class SharedWriteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'SharedWriteError'
  }
}

/**
 * 503 SHARED_BRAIN_READ_ONLY: the shared brain takes no write right now; reads
 * still work. `lasting` when it does not clear up by itself and needs the user.
 */
export function readOnly(reason: string, lasting = false): SharedWriteError {
  const next = lasting ? 'this needs the user — tell them' : 'try the write again once it is back'
  return new SharedWriteError(503, 'SHARED_BRAIN_READ_ONLY', `This shared brain is read-only right now: ${reason}. Reads still work; ${next}.`)
}

/** 503 BRAIN_BUSY: a project is being moved out of this brain (move.ts holds its lock); nothing was written. Text agreed by Dominik 2026-11-03. */
export function busy(): SharedWriteError {
  return new SharedWriteError(503, 'BRAIN_BUSY', 'This brain is busy right now: a project is being moved out of it. Reads still work; try the write again in a moment.')
}

/**
 * The members a shared brain's reads see as its users (core spacePeople);
 * undefined for a private brain, none for a shared one whose team file
 * cannot be used.
 */
export function spaceMembers(sync: Sync | Error | undefined): SpaceMember[] | undefined {
  if (sync === undefined) return undefined
  return sync instanceof Error ? [] : sync.spaceMembers()
}

/**
 * A task's assignee_ids name who works in the brain: its users and agents as
 * eml_read_object lists them (core spacePeople), or the writer and its agent.
 * Checked here, where the write is authored, and never on replay: a shared
 * brain's member handles are readable only with its key, so replicas could
 * judge an op differently, and older ops keep what they assigned.
 */
function checkAssignees(eml: EML, command: { name: CommandName, input: unknown }, env: Env, sync: Sync | undefined): void {
  const input = command.input as Record<string, unknown> | null
  const handles = command.name === 'engram.create' ? (input?.properties as Record<string, unknown> | undefined)?.assignee_ids
    : command.name === 'task.track' ? input?.assignee_ids
    : undefined
  if (!Array.isArray(handles) || handles.length === 0) return
  const known = knownAssignees(eml, spaceMembers(sync))
  for (const own of [env.actor.handle, env.actor.agent]) if (own) known.add(own)
  const unknown = handles.filter(h => typeof h !== 'string' || !known.has(h))
  if (unknown.length === 0) return
  const list = [...known].sort().join(', ')
  throw new CommandError('INVALID', `Invalid engram: assignee_ids names ${unknown.map(h => `"${String(h)}"`).join(', ')}, who ${unknown.length > 1 ? 'do' : 'does'} not work in this brain. Known handles: ${list || 'none'} (eml_read_object object=user · agent).`)
}

/**
 * A task an agent writes has a project and an owner: its scope is project.<id>, and its
 * assignee_ids name at least one person of the brain (spacePeople's users, or the writer's
 * own handle) and no agent — an agent works on a task as its delegate, never as its owner
 * (decision task-assignee-owner-and-agent-delegate). Applies to a create, and to a track that
 * moves the task or replaces its owners. Checked where the write is authored, like
 * assignee_ids, never on replay: what older ops wrote stays, and a person's own writes are free.
 */
function checkAgentTask(eml: EML, command: { name: CommandName, input: unknown }, env: Env, sync: Sync | undefined): void {
  if (!env.actor.agent) return
  const input = command.input as Record<string, unknown> | null
  const create = command.name === 'engram.create' && input?.type === 'task'
  if (!create && command.name !== 'task.track') return
  const scope = input?.scope
  if ((create || scope !== undefined) && !(typeof scope === 'string' && scope.startsWith('project.'))) {
    throw new CommandError('INVALID', `Invalid engram: a task an agent ${create ? 'creates' : 'moves'} belongs to a project — scope project.<id>, not ${typeof scope === 'string' ? scope : 'none'}. Take the project the work is for (the parent task's project for a sub-task).`)
  }
  const owners = create ? (input?.properties as Record<string, unknown> | undefined)?.assignee_ids : input?.assignee_ids
  if (!create && owners === undefined) return
  const handles = Array.isArray(owners) ? owners.filter((h): h is string => typeof h === 'string') : []
  const { users, agents } = spacePeople(eml, spaceMembers(sync))
  const agentIds = new Set([...agents.map(a => a.id), env.actor.agent])
  const people = new Set(users.map(u => u.id as string))
  if (env.actor.handle) people.add(env.actor.handle)
  for (const id of agentIds) if (id !== env.actor.handle) people.delete(id)
  const asAgents = handles.filter(h => agentIds.has(h) && !people.has(h))
  if (asAgents.length > 0) {
    throw new CommandError('INVALID', `Invalid engram: assignee_ids names the agent ${asAgents.map(h => `"${h}"`).join(', ')} — assignee_ids is the task's owner, a person; an agent working on it is its delegate.`)
  }
  if (!handles.some(h => people.has(h))) {
    throw new CommandError('INVALID', `Invalid engram: a task an agent ${create ? 'creates' : 'changes'} has an owner — assignee_ids names at least one person (${[...people].sort().join(', ') || 'none'}). Take the parent task's owner for a sub-task, else ${env.actor.handle ?? 'the person you work for'}.`)
  }
}

/**
 * A task's delegate is one agent of the brain (spacePeople's agents, or the writer's own
 * agent), whether written flat (delegate) or as delegation.agent (v0.23). Checked where the
 * write is authored, like assignee_ids, never on replay.
 */
function checkDelegate(eml: EML, command: { name: CommandName, input: unknown }, env: Env, sync: Sync | undefined): void {
  const input = command.input as Record<string, unknown> | null
  const fields = command.name === 'engram.create' ? input?.properties as Record<string, unknown> | undefined
    : command.name === 'task.track' ? input ?? undefined
    : undefined
  const delegation = fields?.delegation as Record<string, unknown> | null | undefined
  const delegate = fields?.delegate ?? (delegation && typeof delegation === 'object' ? delegation.agent : undefined)
  if (typeof delegate !== 'string') return
  const agents = new Set(spacePeople(eml, spaceMembers(sync)).agents.map(a => a.id))
  if (env.actor.agent) agents.add(env.actor.agent)
  if (agents.has(delegate)) return
  throw new CommandError('INVALID', `Invalid engram: delegate names "${delegate}", who is not an agent of this brain. Agents: ${[...agents].sort().join(', ') || 'none'} (eml_read_object object=agent).`)
}
