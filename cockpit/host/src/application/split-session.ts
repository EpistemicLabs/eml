import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import { planSplit, type SplitRefusal, type SplitRelation, type SplitWhen } from '../domain/split.js'
import type { TaskCommand, TaskCommandStore } from './task-commands.js'

/**
 * Split off a topic from a session (domain/split.ts plans it): make the task and its link, write both
 * journals, and start the new session in a pane next to the one it came from. It happens at once, so
 * the pane can open; Undo stays open for SPLIT_UNDO_MS, drops the new task (invalidated) and ends the
 * new session. The command lives in the task commands' file, under its operation id, so a retry does
 * the work once and the one undo route serves it.
 */

export const SPLIT_UNDO_MS = 5 * 60 * 1000

export interface SplitInput {
  opId: string
  sessionId: string
  title: string
  brief: string
  relation: SplitRelation
  when: SplitWhen
  /** The registry project the new task and session belong to. */
  projectId: string
  /** An open task to split onto instead of making a new one. */
  existingTaskId?: string
}

export interface SessionFacts {
  /** The space as the ledger names it (null = main). */
  spaceId: string | null
  title: string
  taskId: string | null
}

export interface SplitSessionDeps {
  store: TaskCommandStore
  session(sessionId: string): SessionFacts | null
  space(ledgerSpaceId: string | null): BrainSpace
  taskSystem(space: BrainSpace): boolean
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /** The brain project of a registry project of the space; undefined when the space has no such project. */
  brainProject(space: BrainSpace, projectId: string): string | null | undefined
  /** Queue the new session for a pane next to the one it came from; returns its session id. */
  spawn(input: { fromSessionId: string; projectId: string; title: string; prompt: string; taskId: string | null; space: BrainSpace }): string
  endSession(sessionId: string): Promise<void>
  changed(): void
  now(): number
  log(line: string): void
}

export type SplitAnswer =
  | { ok: true; command: TaskCommand }
  | { ok: false; refusal: SplitRefusal | 'unknown_session' | 'unknown_project' | 'unknown_task' | 'no_brain' | 'unknown_command' | 'undo_expired' | 'in_flight'; message?: string }

/** The first message of the new session: the brief, not the chat it came from. */
export function splitPrompt(input: { title: string; brief: string; fromTitle: string; taskId: string | null; existing?: boolean }): string {
  return [
    `This session was split off from the session "${input.fromTitle}". You get this brief, not that chat.`,
    input.existing ? 'The topic already had its task: continue it, starting from its journal and last handoff.' : null,
    `Topic: ${input.title}`,
    input.brief.trim(),
    input.taskId ? `Your task is ${input.taskId}: write your handoffs into it.` : null,
    'Start by saying in two lines what you understood and what you will do first.',
  ].filter(Boolean).join('\n\n')
}

export function createSplitSession(deps: SplitSessionDeps) {
  const iso = (ms: number) => new Date(ms).toISOString()
  /** Operations running now: a second request with the same id is refused, not done twice. */
  const running = new Set<string>()

  const taskOf = async (brain: Pick<EmlApi, 'get'>, taskId: string) =>
    (await brain.get(`/engram/${encodeURIComponent(taskId)}`).catch(() => null)) as { title?: string | null; scope?: string; status?: string } | null

  return {
    async submit(input: SplitInput): Promise<SplitAnswer> {
      const existing = deps.store.get(input.opId)
      if (existing && existing.state !== 'pending') return { ok: true, command: existing }
      if (running.has(input.opId)) return { ok: false, refusal: 'in_flight' }
      running.add(input.opId)
      try {
        return await this.run(input, existing)
      } finally {
        running.delete(input.opId)
      }
    },

    /** The split's steps, each recorded once done: a retry of a split that failed part-way picks up where it stopped. */
    async run(input: SplitInput, existing: TaskCommand | undefined): Promise<SplitAnswer> {
      const facts = deps.session(input.sessionId)
      if (!facts) return { ok: false, refusal: 'unknown_session' }
      const space = deps.space(facts.spaceId)
      const brainProject = deps.brainProject(space, input.projectId)
      if (brainProject === undefined) return { ok: false, refusal: 'unknown_project' }
      const taskSystem = deps.taskSystem(space)
      const brain = deps.brain(space)
      const sourceTask = taskSystem ? facts.taskId : null
      const source = sourceTask && brain ? await taskOf(brain, sourceTask) : null
      // A folder project has no brain project: the new task goes where the session's task is.
      const scope = brainProject ? `project.${brainProject}` : source?.scope ?? 'global'
      let existingTask: { id: string; title: string } | undefined
      if (input.existingTaskId) {
        const found = brain ? await taskOf(brain, input.existingTaskId) : null
        if (!found || (found.status !== 'planned' && found.status !== 'active')) return { ok: false, refusal: 'unknown_task' }
        existingTask = { id: input.existingTaskId, title: found.title ?? input.existingTaskId }
      }
      const planned = planSplit(
        { sessionId: input.sessionId, sessionTitle: facts.title, taskId: sourceTask, taskTitle: source?.title ?? null, taskSystem },
        { title: input.title, brief: input.brief, relation: input.relation, when: input.when, scope, ...(existingTask ? { existing: existingTask } : {}) },
      )
      if (!planned.ok) return planned
      const { plan } = planned
      if ((plan.task || plan.journal.source || plan.journal.existing) && !brain) return { ok: false, refusal: 'no_brain' }

      const started = deps.now()
      let command: TaskCommand = existing ?? {
        opId: input.opId, kind: 'split', spaceId: space.id, createdAt: iso(started), undoUntil: iso(started + SPLIT_UNDO_MS), state: 'pending',
        split: { sessionId: input.sessionId, title: input.title.trim(), relation: input.relation, when: input.when, sourceTaskId: sourceTask, createdTaskId: null, existingTaskId: existingTask?.id ?? null, spawnedSessionId: null },
      }
      const record = (patch: Partial<NonNullable<TaskCommand['split']>>, state: TaskCommand['state'] = 'pending') => {
        command = { ...command, state, split: { ...command.split!, ...patch } }
        deps.store.put(command, deps.now())
      }
      record({})
      const done = command.split!

      let createdTaskId = done.createdTaskId
      if (existingTask && plan.journal.existing && !command.split!.journaled?.existing) {
        await brain!.post(`/task/${existingTask.id}/track`, { text: plan.journal.existing })
        record({ journaled: { ...command.split!.journaled, existing: true } })
      }
      if (plan.task && !createdTaskId) {
        createdTaskId = (await brain!.post('/engram/task', plan.task) as { id: string }).id
        record({ createdTaskId })
      }
      if (createdTaskId && plan.originLink && !command.split!.linked) {
        await brain!.post('/relate', { source_id: createdTaskId, target_id: sourceTask, relation: 'derived_from', detection_method: 'manual', explanation: 'spun off from' })
        record({ linked: true })
      }
      if (createdTaskId && plan.journal.created && !command.split!.journaled?.created) {
        await brain!.post(`/task/${createdTaskId}/track`, { text: plan.journal.created })
        record({ journaled: { ...command.split!.journaled, created: true } })
      }
      if (plan.journal.source && sourceTask && !command.split!.journaled?.source) {
        await brain!.post(`/task/${sourceTask}/track`, { text: plan.journal.source })
        record({ journaled: { ...command.split!.journaled, source: true } })
      }
      let spawnedSessionId = command.split!.spawnedSessionId
      if (plan.spawn && !spawnedSessionId) {
        spawnedSessionId = deps.spawn({
          fromSessionId: input.sessionId,
          projectId: input.projectId,
          title: input.title.trim(),
          prompt: splitPrompt({ title: input.title.trim(), brief: input.brief, fromTitle: facts.title, taskId: createdTaskId ?? existingTask?.id ?? null, existing: Boolean(existingTask) }),
          taskId: createdTaskId ?? existingTask?.id ?? null,
          space,
        })
      }
      record({ spawnedSessionId }, 'applied')
      deps.changed()
      deps.log(`[split] ${input.opId.slice(0, 8)} ${input.relation}/${input.when} from ${input.sessionId.slice(0, 8)}${createdTaskId ? ` task ${createdTaskId.slice(0, 8)}` : ''}${spawnedSessionId ? ` session ${spawnedSessionId.slice(0, 8)}` : ''}`)
      return { ok: true, command }
    },

    /** Whether this operation is a split (the undo route asks before it picks who undoes it). */
    owns(opId: string): boolean {
      return deps.store.get(opId)?.kind === 'split'
    },

    async undo(opId: string): Promise<SplitAnswer> {
      const command = deps.store.get(opId)
      if (!command || command.kind !== 'split' || !command.split || command.state === 'undone') return { ok: false, refusal: 'unknown_command' }
      if (deps.now() > Date.parse(command.undoUntil)) return { ok: false, refusal: 'undo_expired' }
      const { createdTaskId, spawnedSessionId, sourceTaskId, title } = command.split
      if (spawnedSessionId) await deps.endSession(spawnedSessionId)
      const facts = deps.session(command.split.sessionId)
      const brain = deps.brain(deps.space(facts?.spaceId ?? null))
      if ((createdTaskId || sourceTaskId) && !brain) return { ok: false, refusal: 'no_brain' }
      if (createdTaskId) {
        await brain!.post(`/task/${createdTaskId}/track`, { status: 'invalidated', outcome: 'Split undone', text: 'The split was undone in the chat it came from.' })
      }
      if (sourceTaskId && createdTaskId) await brain!.post(`/task/${sourceTaskId}/track`, { text: `The split of ${title} was undone.` })
      const undone: TaskCommand = { ...command, state: 'undone' }
      deps.store.put(undone, deps.now())
      deps.changed()
      deps.log(`[split] ${opId.slice(0, 8)} undone`)
      return { ok: true, command: undone }
    },
  }
}

export type SplitSession = ReturnType<typeof createSplitSession>
