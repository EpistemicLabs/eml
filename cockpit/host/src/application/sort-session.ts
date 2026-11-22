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
  | { ok: false; refusal: 'unknown_session' | 'no_task' | 'no_brain' }

export function createSortSession(deps: SortSessionDeps) {
  return {
    async apply(input: { opId: string; sessionId: string; rows: SortRow[] }): Promise<SortAnswer> {
      const existing = deps.store.get(input.opId)
      if (existing) return { ok: true, command: existing }
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
      const counts = { linked: 0, created: 0, closed: 0 }

      for (const action of planSort(sourceId, input.rows)) {
        if (action.kind === 'link_sub') {
          await brain.post(`/task/${action.taskId}/track`, { parent_id: sourceId, text: `Moved under ${sourceTitle} when ${from} was sorted.` })
          counts.linked++
        } else if (action.kind === 'link_spun') {
          await brain.post('/relate', { source_id: action.taskId, target_id: sourceId, relation: 'derived_from', detection_method: 'manual', explanation: 'spun off from' })
          await brain.post(`/task/${action.taskId}/track`, { text: `Linked as spun off from ${sourceTitle} when ${from} was sorted.` })
          counts.linked++
        } else if (action.kind === 'create') {
          const created = await brain.post('/engram/task', {
            title: action.title, content: action.content, scope: source?.scope ?? 'global', status: 'planned',
            ...(action.parent ? { parent_id: sourceId } : {}),
          }) as { id: string }
          if (action.origin) {
            await brain.post('/relate', { source_id: created.id, target_id: sourceId, relation: 'derived_from', detection_method: 'manual', explanation: 'spun off from' })
          }
          await brain.post(`/task/${created.id}/track`, { text: `Came up in ${from}; made a task of its own when that session was sorted.` })
          counts.created++
        } else {
          await brain.post(`/task/${action.taskId}/track`, { status: 'invalidated', outcome: 'Dropped when its session was sorted', text: `Dropped when ${from} was sorted.` })
          counts.closed++
        }
      }
      await brain.post(`/task/${sourceId}/track`, { text: `This session was sorted: ${counts.linked} linked, ${counts.created} created, ${counts.closed} closed.` })

      const now = deps.now()
      const at = new Date(now).toISOString()
      const command: TaskCommand = { opId: input.opId, kind: 'sort', spaceId: space.id, createdAt: at, undoUntil: at, state: 'applied', sort: counts }
      deps.store.put(command, now)
      deps.changed()
      deps.log(`[sort] ${input.opId.slice(0, 8)} ${input.sessionId.slice(0, 8)}: ${counts.linked} linked, ${counts.created} created, ${counts.closed} closed`)
      return { ok: true, command }
    },
  }
}

export type SortSession = ReturnType<typeof createSortSession>
