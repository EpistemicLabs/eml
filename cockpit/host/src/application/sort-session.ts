import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import { planSort, type SortRow } from '../domain/sort.js'
import type { SessionFacts } from './split-session.js'
import type { TaskCommand, TaskCommandStore } from './task-commands.js'
import { ownersFor, projectScope, type OwnedTask } from '../domain/task-owner.js'
import type { DelegationFields, ScheduleFields } from '../domain/delegation.js'

/**
 * Apply a sort of a drifted session (domain/sort.ts plans it): link, create and close as the rows say,
 * each with a journal entry, and one entry on the session's task that sums it up. A task whose schedule is
 * still on is not dropped (it closes with End schedule on the board): it is kept, and the entries say so. Only for a session
 * with a task: sorting means putting topics next to it. Kept in the task commands' file under its
 * operation id, so a retry does the work once.
 */

export interface SortSessionDeps {
  store: TaskCommandStore
  session(sessionId: string): SessionFacts | null
  space(ledgerSpaceId: string | null): BrainSpace
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  changed(): void
  now(): number
  log(line: string): void
  /** This cockpit's member: a new task's owner when the session's task names none. */
  me: string
  /** The task's schedule is still on (domain/task-schedule.ts hasSchedule): a drop leaves it open. Without it none is. */
  scheduled?(task: ScheduledTask): boolean
}

type ScheduledTask = { id: string; properties?: { assignee_ids?: string[]; delegation?: DelegationFields; schedule?: ScheduleFields | null } }

export type SortAnswer =
  | { ok: true; command: TaskCommand }
  | { ok: false; refusal: 'unknown_session' | 'no_task' | 'no_project' | 'no_brain' | 'in_flight' }

export function createSortSession(deps: SortSessionDeps) {
  const running = new Set<string>()
  return {
    async apply(input: { opId: string; sessionId: string; rows: SortRow[] }): Promise<SortAnswer> {
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

    /** The sort's actions, each recorded once done: a retry of a sort that failed part-way picks up where it stopped. */
    async run(input: { opId: string; sessionId: string; rows: SortRow[] }, existing: TaskCommand | undefined): Promise<SortAnswer> {
      const facts = deps.session(input.sessionId)
      if (!facts) return { ok: false, refusal: 'unknown_session' }
      const space = deps.space(facts.spaceId)
      if (!facts.taskId) return { ok: false, refusal: 'no_task' }
      const brain = deps.brain(space)
      if (!brain) return { ok: false, refusal: 'no_brain' }
      const sourceId = facts.taskId
      const source = await brain.get(`/engram/${encodeURIComponent(sourceId)}`).catch(() => null) as ({ title?: string; scope?: string } & OwnedTask) | null
      const sourceTitle = source?.title ?? sourceId
      // New tasks take the project and the owners of the session's task; one outside every project has none to give.
      const scope = projectScope(source?.scope)
      const owners = ownersFor(source, deps.me)
      const actions = planSort(sourceId, input.rows)
      if (!scope && actions.some((a) => a.kind === 'create')) return { ok: false, refusal: 'no_project' }
      const from =`the session "${facts.title}" (task ${sourceTitle})`
      const at = new Date(deps.now()).toISOString()
      let command: TaskCommand = existing ?? {
        opId: input.opId, kind: 'sort', spaceId: space.id, createdAt: at, undoUntil: at, state: 'pending',
        sort: { linked: 0, created: 0, closed: 0 }, sortProgress: { next: 0, created: {} },
      }
      const save = (patch: Partial<TaskCommand>) => {
        command = { ...command, ...patch }
        deps.store.put(command, deps.now())
      }
      save({})
      const counts = { ...command.sort! }
      const progress = { next: 0, created: {} as Record<string, string>, createdSteps: {} as Record<string, { linked?: boolean; journaled?: boolean }>, ...command.sortProgress }

      for (let i = progress.next; i < actions.length; i++) {
        const action = actions[i]
        if (action.kind === 'link_sub') {
          await brain.post(`/task/${action.taskId}/track`, { parent_id: sourceId, text: `Moved under ${sourceTitle} when ${from} was sorted.` })
          counts.linked++
        } else if (action.kind === 'link_spun') {
          await brain.post('/relate', { source_id: action.taskId, target_id: sourceId, relation: 'derived_from', detection_method: 'manual', explanation: 'spun off from' })
          await brain.post(`/task/${action.taskId}/track`, { text: `Linked as spun off from ${sourceTitle} when ${from} was sorted.` })
          counts.linked++
        } else if (action.kind === 'create') {
          // A create is three writes; each is recorded, so a retry neither makes the task twice nor links it twice.
          const key = String(i)
          if (!progress.created[key]) {
            progress.created[key] = (await brain.post('/engram/task', {
              title: action.title, ...(action.displayTitle ? { display_title: action.displayTitle } : {}), content: action.content, scope, assignee_ids: owners, status: 'planned',
              ...(action.parent ? { parent_id: sourceId } : {}),
            }) as { id: string }).id
            save({ sortProgress: progress })
          }
          const id = progress.created[key]
          const steps = progress.createdSteps[key] ?? {}
          if (action.origin && !steps.linked) {
            await brain.post('/relate', { source_id: id, target_id: sourceId, relation: 'derived_from', detection_method: 'manual', explanation: 'spun off from' })
            progress.createdSteps[key] = { ...steps, linked: true }
            save({ sortProgress: progress })
          }
          if (!progress.createdSteps[key]?.journaled) {
            await brain.post(`/task/${id}/track`, { text: `Came up in ${from}; made a task of its own when that session was sorted.` })
            progress.createdSteps[key] = { ...progress.createdSteps[key], journaled: true }
          }
          counts.created++
        } else {
          const task = deps.scheduled ? await brain.get(`/engram/${encodeURIComponent(action.taskId)}`).catch(() => null) as ScheduledTask | null : null
          if (task && deps.scheduled?.(task)) {
            await brain.post(`/task/${action.taskId}/track`, { text: `Not dropped when ${from} was sorted: its schedule is still on. End schedule and close on the task board closes it.` })
            counts.kept = (counts.kept ?? 0) + 1
          } else {
            await brain.post(`/task/${action.taskId}/track`, { status: 'invalidated', outcome: 'Dropped when its session was sorted', text: `Dropped when ${from} was sorted.` })
            counts.closed++
          }
        }
        progress.next = i + 1
        save({ sort: counts, sortProgress: progress })
      }
      const summary = `${counts.linked} linked, ${counts.created} created, ${counts.closed} closed${counts.kept ? `, ${counts.kept} kept open (schedule still on)` : ''}`
      if (!progress.summed) {
        await brain.post(`/task/${sourceId}/track`, { text: `This session was sorted: ${summary}.` })
        progress.summed = true
      }
      save({ state: 'applied', sort: counts, sortProgress: progress })
      deps.changed()
      deps.log(`[sort] ${input.opId.slice(0, 8)} ${input.sessionId.slice(0, 8)}: ${summary}`)
      return { ok: true, command }
    },
  }
}

export type SortSession = ReturnType<typeof createSortSession>
