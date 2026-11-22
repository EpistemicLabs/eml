import { kebabTitle } from './task-title.js'

/**
 * Sort a drifted session: a long session covered many topics, and each one should land where it
 * belongs. The agent proposes a pick per topic; the user changes what is wrong and applies. Applying
 * links the topics that already have a task, creates the missing tasks (planned: nothing starts on its
 * own) with a brief each, and closes the dropped ones. Every change is written into a journal, which is
 * the record; there is no undo, because a link the brain made cannot be taken back.
 */

export type SortPick = 'keep' | 'sub' | 'spun' | 'unrelated' | 'drop'
export const SORT_PICKS: readonly SortPick[] = ['keep', 'sub', 'spun', 'unrelated', 'drop']

export interface SortRow {
  topic: string
  pick: SortPick
  /** The task the topic already has, if any. */
  taskId?: string
  /** What the new task's session would need, for a topic without a task. */
  brief?: string
}

export type SortAction =
  | { kind: 'link_sub'; taskId: string }
  | { kind: 'link_spun'; taskId: string }
  | { kind: 'create'; title: string; content: string; parent: boolean; origin: boolean }
  | { kind: 'close'; taskId: string }

/** What applying the rows does, in order; topics kept here, or dropped without a task, do nothing. */
export function planSort(sessionTaskId: string, rows: SortRow[]): SortAction[] {
  const actions: SortAction[] = []
  for (const row of rows) {
    const topic = row.topic.trim()
    if (!topic || row.pick === 'keep' || row.taskId === sessionTaskId) continue
    if (row.taskId) {
      if (row.pick === 'sub') actions.push({ kind: 'link_sub', taskId: row.taskId })
      else if (row.pick === 'spun') actions.push({ kind: 'link_spun', taskId: row.taskId })
      else if (row.pick === 'drop') actions.push({ kind: 'close', taskId: row.taskId })
      continue
    }
    if (row.pick === 'drop') continue
    const title = kebabTitle(topic)
    if (!title) continue
    actions.push({ kind: 'create', title, content: [topic, row.brief?.trim()].filter(Boolean).join('\n\n'), parent: row.pick === 'sub', origin: row.pick === 'spun' })
  }
  return actions
}
