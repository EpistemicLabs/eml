/**
 * Who owns a task, and whether this cockpit's background work may act on it. The owner is the first
 * person in assignee_ids, else the task's author (ingested_by). In a local space every task is this
 * member's. In a shared space each member's cockpit runs the background work (runner, cycles) on its
 * own member's tasks only, so two cockpits never act on the same task; a space whose sharing is not
 * confirmed yet counts as shared.
 */

export interface OwnedTask {
  ingested_by?: string | null
  properties?: { assignee_ids?: string[] } | null
}

export const ownerOf = (task: OwnedTask): string | null => task.properties?.assignee_ids?.[0] ?? task.ingested_by ?? null

/** This cockpit, whose member is `me`, may act on the task in a space shared or not. */
export const runsHere = (shared: boolean | null, task: OwnedTask, me: string): boolean => shared === false || ownerOf(task) === me
