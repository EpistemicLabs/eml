/** A task as far as its part_of relations go: a step is part_of its parent. */
export interface TaskRelations {
  id: string
  relations?: Array<{ relation: string; source_id: string; target_id: string }>
}

/** The task this one is a step of, or null. */
export const parentOf = (task: TaskRelations): string | null =>
  task.relations?.find((r) => r.relation === 'part_of' && r.source_id === task.id)?.target_id ?? null

/** The ids of the tasks that replaced this one: the sources of a `supersedes` relation onto it (domain/task-replacement.ts). */
export const replacingIds = (task: TaskRelations): string[] =>
  [...new Set((task.relations ?? []).filter((r) => r.relation === 'supersedes' && r.target_id === task.id && r.source_id !== task.id).map((r) => r.source_id))]

/** The ids of this task's steps. */
export const childrenOf = (task: TaskRelations): string[] =>
  (task.relations ?? []).filter((r) => r.relation === 'part_of' && r.target_id === task.id).map((r) => r.source_id)
