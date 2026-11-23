import * as fs from 'node:fs'
import * as path from 'node:path'
import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import type { Delegation } from '../domain/hand-over.js'
import { runsHere } from '../domain/task-owner.js'

/**
 * The one-off backfill of delegation.mode (task state migration, step 2). Brain schema 23 gave every
 * delegated task a delegation with mode alone. The mode is only known on the cockpit that has the
 * task's sessions: a delegated task its owner works on together with the agent right now becomes
 * together, with a journal line, so the runner never starts it alone and the release puts it back
 * once the session is put away. Every other task stays alone, as the migration wrote it: rewriting
 * an unchanged value would only add a journal line per task to the shared log.
 *
 * Together means: on this cockpit an open Work on it now covers the task, or a session the user
 * started on it (not a worker or a job's run) is open and the latest hand-over here was not a
 * Delegate now or a Schedule (after those the owner's open pane does not hold the agent back).
 *
 * Only this member's tasks (domain/task-owner.ts), once per space: a marker file records the spaces
 * done, so a restart does not run it again. A space whose brain is not reachable is tried again on
 * the next start.
 */

export interface BackfillTask {
  id: string
  status: string
  ingested_by?: string | null
  properties?: { assignee_ids?: string[]; delegation?: Delegation }
}

export interface DelegationBackfillDeps {
  spaces(): BrainSpace[]
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  me: string
  /** An open Work on it now on this cockpit covers the task. */
  together(taskId: string): boolean
  /** The latest hand-over on this cockpit was a Delegate now or a Schedule. */
  handedAlone(taskId: string): boolean
  /** A session the user started on the task (not a worker or a job's run) is open on this cockpit. */
  userSessionOpen(taskId: string): boolean
  /** The marker file: the ids of the spaces already done. */
  markerFile: string
  log(line: string): void
}

const PAGE = 200

export const BACKFILL_LINE = (agent: string) =>
  `Delegation mode set to together (one-off backfill): the owner works on this task with ${agent} in an open session, so ${agent} does not go on alone.`

function readDone(file: string): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { spaces?: unknown }
    return new Set(Array.isArray(parsed.spaces) ? parsed.spaces.filter((s): s is string => typeof s === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeDone(file: string, done: Set<string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ spaces: [...done].sort() }, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Whether the task's owner works on it together with its delegate, as this cockpit sees it. */
export function worksTogether(task: BackfillTask, deps: Pick<DelegationBackfillDeps, 'together' | 'handedAlone' | 'userSessionOpen'>): boolean {
  if (deps.together(task.id)) return true
  return deps.userSessionOpen(task.id) && !deps.handedAlone(task.id)
}

/** Runs the backfill in every space not done yet; returns the ids of the tasks it set to together. */
export async function backfillDelegationMode(deps: DelegationBackfillDeps): Promise<string[]> {
  const done = readDone(deps.markerFile)
  const changed: string[] = []
  for (const space of deps.spaces()) {
    if (done.has(space.id)) continue
    const brain = deps.brain(space)
    if (!brain) continue
    try {
      const open: BackfillTask[] = []
      for (const status of ['planned', 'active']) {
        for (let offset = 0; ; offset += PAGE) {
          const listed = await brain.get('/list', { type: 'task', status, limit: PAGE, offset }) as { engrams?: BackfillTask[] }
          open.push(...(listed.engrams ?? []))
          if ((listed.engrams ?? []).length < PAGE) break
        }
      }
      for (const task of open) {
        const delegation = task.properties?.delegation
        if (!delegation || delegation.mode !== 'alone' || !runsHere(space.shared, task, deps.me)) continue
        if (!worksTogether(task, deps)) continue
        await brain.post(`/task/${task.id}/track`, { delegation: { ...delegation, mode: 'together' }, text: BACKFILL_LINE(delegation.agent) })
        changed.push(task.id)
        deps.log(`[backfill] task ${task.id.slice(0, 8)}: delegation mode together (${delegation.agent})`)
      }
      done.add(space.id)
      writeDone(deps.markerFile, done)
    } catch (err) {
      deps.log(`[backfill] ${space.name}: delegation mode not backfilled, tried again on the next start: ${(err as Error).message}`)
    }
  }
  return changed
}
