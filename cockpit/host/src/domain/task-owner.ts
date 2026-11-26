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

/**
 * Whose cockpit fires a task's schedule: the one rule for the engine (application/job-runner.ts) and for the
 * migration of the jobs of before (domain/job-migration.ts), so what one writes the other fires.
 *
 *   - `mine`: this cockpit fires it. In a local space that is every task; in a shared one the tasks whose owner
 *     (ownerOf) is this member.
 *   - `theirs`: another member owns it (the first assignee, or with nobody assigned its author, who is a member of
 *     the space): their cockpit fires it.
 *   - `ownerless`: no member owns it (nobody is assigned, and its author is no member: an agent, or nobody). No rule
 *     names a cockpit for it, so the cockpit that holds a local record for it fires it (firesHere), and a record for
 *     such a task is only ever made by an explicit act on that machine (the schedule tool, a session ending its turn
 *     with a time, the page, the migration), never by seeing the task.
 *   - `unknown`: it cannot be said yet: the brain server has not said whether the space is shared (`shared` null),
 *     or its members could not be read (`members` null) for a task whose author would decide. Nothing fires and
 *     nothing is planned until it is known.
 */
export type TaskFiring = 'mine' | 'theirs' | 'ownerless' | 'unknown'

/** `members`: the people of the space (its brain's users), null when they could not be read. */
export function firingOf(shared: boolean | null, task: OwnedTask, me: string, members: readonly string[] | null): TaskFiring {
  if (shared === null) return 'unknown'
  if (shared === false || ownerOf(task) === me) return 'mine'
  if (task.properties?.assignee_ids?.[0]) return 'theirs'
  const author = task.ingested_by ?? null
  if (author === null) return 'ownerless'
  if (members === null) return 'unknown'
  return members.includes(author) ? 'theirs' : 'ownerless'
}

/** This cockpit fires the task: it is this member's, or no member owns it and this cockpit holds its record. */
export const firesHere = (firing: TaskFiring, hasRecord: boolean): boolean => firing === 'mine' || (firing === 'ownerless' && hasRecord)

/**
 * The owners of a task this cockpit makes. The brain refuses a task an agent writes without a person as its owner
 * (packages/server/src/write.ts checkAgentTask), so the cockpit names one: the owners of the task the new one comes
 * from (its parent, the task it follows or splits from), else this cockpit's member.
 */
export const ownersFor = (from: OwnedTask | null | undefined, me: string): string[] => {
  const owners = from?.properties?.assignee_ids ?? []
  return owners.length > 0 ? owners : [me]
}

/** A scope a task the cockpit makes may take: a project's, never global or another scope; null when there is none. */
export const projectScope = (scope: string | null | undefined): string | null => (scope?.startsWith('project.') ? scope : null)
