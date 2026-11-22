import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import { planSort, type SortRow } from '../domain/sort.js'
import type { SessionFacts } from './split-session.js'
import type { TaskCommand, TaskCommandStore } from './task-commands.js'

/**
 * Apply a sort of a drifted session (domain/sort.ts plans it): link, create and close as the rows say,
 * each with a journal entry, and one entry on the session's task that sums it up. Only where the task
 * system is on: sorting means putting topics next to the session's task. Kept in the task commands'
 * file under its operation id, so a retry does the work once.
 */

export interface SortSessionDeps {
  store: TaskCommandStore
  session(sessionId: string): SessionFacts | null
  space(ledgerSpaceId: string | null): BrainSpace
  taskSystem(space: BrainSpace): boolean
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  changed(): void
  now(): number
  log(line: string): void
}

export type SortAnswer =
  | { ok: true; command: TaskCommand }
  | { ok: false; refusal: 'unknown_session' | 'no_task' | 'no_brain' | 'in_flight' }

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
      if (!deps.taskSystem(space) || !facts.taskId) return { ok: false, refusal: 'no_task' }
      const brain = deps.brain(space)
      if (!brain) return { ok: false, refusal: 'no_brain' }
      const sourceId = facts.taskId
      const source = await brain.get(`/engram/${encodeURIComponent(sourceId)}`).catch(() => null) as { title?: string; scope?: string } | null
      const sourceTitle = source?.title ?? sourceId
      const from = `the session "${facts.title}" (task ${sourceTitle})`
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
      const actions = planSort(sourceId, input.rows)

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
              title: action.title, content: action.content, scope: source?.scope ?? 'global', status: 'planned',
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
          await brain.post(`/task/${action.taskId}/track`, { status: 'invalidated', outcome: 'Dropped when its session was sorted', text: `Dropped when ${from} was sorted.` })
          counts.closed++
        }
        progress.next = i + 1
        save({ sort: counts, sortProgress: progress })
      }
      if (!progress.summed) {
        await brain.post(`/task/${sourceId}/track`, { text: `This session was sorted: ${counts.linked} linked, ${counts.created} created, ${counts.closed} closed.` })
        progress.summed = true
      }
      save({ state: 'applied', sort: counts, sortProgress: progress })
      deps.changed()
      deps.log(`[sort] ${input.opId.slice(0, 8)} ${input.sessionId.slice(0, 8)}: ${counts.linked} linked, ${counts.created} created, ${counts.closed} closed`)
      return { ok: true, command }
    },
  }
}

export type SortSession = ReturnType<typeof createSortSession>
