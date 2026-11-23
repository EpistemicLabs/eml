import type { EmlApi } from '@engramprotocol/mcp-server'

/**
 * A read-change-write of one task's waits. The list is written whole, so two
 * writers on one brain that read the same list would drop each other's wait:
 * the write carries the rev it was read at (base_rev), and when the task moved
 * in between, it reads again and redoes the change once.
 *
 * In a shared brain each member writes their own replica, and the relay orders
 * the ops; two members changing one task's waits in the same moment can still
 * overwrite each other. A session's next turn writes its wait again.
 */

export interface WaitTask {
  id: string
  status: string
  rev?: number
  properties?: Record<string, unknown> & { checkpoint?: string; waits?: unknown; waiting_on?: unknown }
}

const isConflict = (err: unknown) => (err as { status?: number })?.status === 409

/**
 * Reads the task, asks `change` for the track body (null: nothing to write) and
 * writes it. Returns the task as read and the body written (null when none).
 */
export async function trackWaits(
  brain: Pick<EmlApi, 'get' | 'post'>,
  taskId: string,
  change: (task: WaitTask) => Record<string, unknown> | null,
): Promise<{ task: WaitTask; patch: Record<string, unknown> | null }> {
  for (let attempt = 0; ; attempt++) {
    const task = await brain.get(`/engram/${taskId}`) as WaitTask
    const patch = change(task)
    if (!patch) return { task, patch: null }
    try {
      await brain.post(`/task/${task.id}/track`, typeof task.rev === 'number' ? { ...patch, base_rev: task.rev } : patch)
      return { task, patch }
    } catch (err) {
      if (attempt > 0 || !isConflict(err)) throw err
    }
  }
}
