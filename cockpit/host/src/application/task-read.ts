import { EmlApiError, type EmlApi } from '@engramprotocol/mcp-server'

/**
 * How a space's tasks are read from its brain by what works with their schedules: the engine
 * (application/job-runner.ts), the schedule tool (application/jobs.ts) and the jobs migration
 * (application/job-migration.ts).
 */

/** How many open tasks of one status are read per space; a task beyond the list is not seen. */
export const OPEN_TASKS_LIMIT = 500

/**
 * One task by its id, also a closed one; null when the brain has none, or the id names something that is no task.
 * Any other failure throws.
 */
export async function taskById<T>(brain: Pick<EmlApi, 'get'>, id: string): Promise<T | null> {
  try {
    const found = await brain.get(`/engram/${encodeURIComponent(id)}`) as (T & { type?: string }) | null
    return found && (found.type === undefined || found.type === 'task') ? found : null
  } catch (err) {
    if (err instanceof EmlApiError && err.status === 404) return null
    throw err
  }
}

/** The space's open tasks (planned and active) with their properties: two reads, none per task. */
export async function openTasks<T>(brain: Pick<EmlApi, 'get'>): Promise<T[]> {
  const lists = await Promise.all(['planned', 'active'].map((status) => brain.get('/list', { type: 'task', status, limit: OPEN_TASKS_LIMIT }) as Promise<{ engrams?: T[] }>))
  return lists.flatMap((list) => list.engrams ?? [])
}
