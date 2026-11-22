/**
 * Split off: a new topic leaves the session it came up in for a task (and a session) of its own. How it
 * relates decides the link: spun off (its own task, linked to the one it came from as its origin),
 * sub-task (under the session's task, which can't close before it) or unrelated (its own task, no link;
 * the journal says where it came up). When decides whether a session starts now or the task waits in
 * Plan. This file plans the change; application/split-session.ts carries it out and keeps it undoable.
 *
 * Where the task system is off (a shared space), sessions have no task: starting now writes nothing to
 * the brain (the new session only remembers the one it came from), and parking makes one ordinary task
 * that holds the brief.
 */

import { kebabTitle } from './task-title.js'

export type SplitRelation = 'spun' | 'sub' | 'unrelated'
export type SplitWhen = 'now' | 'park'
export const SPLIT_RELATIONS: readonly SplitRelation[] = ['spun', 'sub', 'unrelated']
export const SPLIT_WHENS: readonly SplitWhen[] = ['now', 'park']

export interface SplitSource {
  sessionId: string
  sessionTitle: string
  /** The session's task; null where the task system is off or the session has none. */
  taskId: string | null
  taskTitle: string | null
  taskSystem: boolean
}

export interface SplitRequest {
  title: string
  brief: string
  relation: SplitRelation
  when: SplitWhen
  /** The brain scope of the new task (project.<id>). */
  scope: string
}

export interface SplitPlan {
  task: { title: string; content: string; scope: string; status: 'active' | 'planned'; parent_id?: string } | null
  /** Link the new task to the session's task as the task it was spun off from (derived_from). */
  originLink: boolean
  journal: { created?: string; source?: string }
  /** Start a session on it now, in a pane next to the one it came from. */
  spawn: boolean
}

export type SplitRefusal = 'invalid' | 'sub_needs_task'

export function planSplit(source: SplitSource, request: SplitRequest): { ok: true; plan: SplitPlan } | { ok: false; refusal: SplitRefusal } {
  const title = request.title.trim()
  const brief = request.brief.trim()
  const anchor = kebabTitle(title)
  if (!anchor || !brief) return { ok: false, refusal: 'invalid' }
  const hasTask = source.taskSystem && source.taskId !== null
  if (request.relation === 'sub' && !hasTask) return { ok: false, refusal: 'sub_needs_task' }
  const spawn = request.when === 'now'
  const status = spawn ? 'active' as const : 'planned' as const
  const body = `${title}\n\n${brief}`

  if (!hasTask) {
    if (spawn) return { ok: true, plan: { task: null, originLink: false, journal: {}, spawn: true } }
    return {
      ok: true,
      plan: {
        task: { title: anchor, content: `${body}\n\nCame up in session ${source.sessionTitle}.`, scope: request.scope, status },
        originLink: false,
        journal: {},
        spawn: false,
      },
    }
  }

  const from = `${source.taskTitle ?? source.taskId} (session ${source.sessionTitle})`
  const journal = request.relation === 'spun'
    ? { created: `Spun off from ${from}.`, source: `${title} was spun off here as its own task.` }
    : request.relation === 'sub'
      ? { created: `Split off from ${from} as a sub-task.`, source: `${title} was split off here as a sub-task; this task can't close before it.` }
      : { created: `Came up in ${from}; not part of that task.`, source: `${title} came up here and moved to a task of its own.` }
  return {
    ok: true,
    plan: {
      task: { title: anchor, content: body, scope: request.scope, status, ...(request.relation === 'sub' ? { parent_id: source.taskId! } : {}) },
      originLink: request.relation === 'spun',
      journal,
      spawn,
    },
  }
}
