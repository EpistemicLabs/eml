import { ownerOf, runsHere, type OwnedTask } from './task-owner.js'
import { requestOpen, type DelegationFields } from './delegation.js'

/**
 * Whether the runner (application/task-runner.ts) starts a delegated task now, and if not, why. The runner and the
 * task board both ask this one function, so the board never says "next in line" for a task the runner skips.
 *
 * The checks come in the order a person needs the reason: something that is not runner work at all first, then a
 * wait on someone, a hold, the tree (parent, depends_on), the cap, and last that the task runs on another member's
 * cockpit. Every check has to pass for a start, so the order only picks which reason is named.
 */

export const MAX_RUNNING = 5

/** A task one of the runner's checks reads: the task, its parent and its depends_on steps as the brain has them. */
export interface GateTask extends OwnedTask {
  id: string
  status: string
  scope: string
  title?: string | null
  properties?: (OwnedTask['properties'] & {
    checkpoint?: string
    delegate?: string
    delegation?: DelegationFields | null
    display_title?: string
    waiting_on?: { who?: string; kind?: string; why?: string } | Record<string, string>
  }) | null
}

export interface GateInput {
  task: GateTask
  /** The task's parent (task null: the brain could not give it); undefined when it has none. */
  parent?: { id: string; task: GateTask | null }
  /** Its depends_on steps in order; null for one the brain could not give. */
  deps: Array<{ id: string; task: GateTask | null }>
  /** Active tasks in its cap group (its parent's steps, or the space's standalone delegated tasks) that hold a slot. */
  running: number
  /** In a shared space (or one whose sharing is not confirmed yet), each member's cockpit starts only its member's tasks. */
  shared: boolean | null
  /** This cockpit's member. */
  me: string
  /** A session works on it already. */
  busy?: boolean
  /** Its hand-over can still be undone, or the owner works on it with the agent (Work on it now). */
  held?: boolean
  /** A job of its own will start it at a set time. */
  scheduled?: boolean
  /** When the newest run on the task started (any state), or null: a request is open while no run started after it. */
  lastRunStartedAt?: string | null
}

export type RunnerBlock =
  /** Not runner work: closed, without a delegation with a checkpoint, or no open request (domain/delegation.ts). */
  | { kind: 'not_runner_work' }
  | { kind: 'waiting'; who: string }
  | { kind: 'scheduled' }
  | { kind: 'held' }
  | { kind: 'busy' }
  /** Its parent is not active (status null: the brain could not give it). */
  | { kind: 'parent'; parentId: string; status: string | null }
  /** The first of its depends_on steps that is not resolved (status null: the brain could not give it); `more` others wait too. */
  | { kind: 'depends'; stepId: string; title: string | null; status: string | null; more: number }
  | { kind: 'cap'; running: number; max: number; standalone: boolean }
  /** It is not in a project, so there is nowhere to start its session. */
  | { kind: 'no_project'; scope: string }
  /** In a shared space the owner's cockpit starts it, not this one. */
  | { kind: 'other_member'; owner: string | null }

const nameOf = (t: GateTask) => t.properties?.display_title ?? t.title ?? null

/** Null when the runner starts the task now; else the first reason it does not. */
export function runnerBlock(input: GateInput): RunnerBlock | null {
  const { task } = input
  const props = task.properties ?? {}
  if (!requestOpen(task, input.lastRunStartedAt ?? null)) return { kind: 'not_runner_work' }
  const who = (props.waiting_on as { who?: string } | undefined)?.who
  if (who) return { kind: 'waiting', who }
  if (input.scheduled) return { kind: 'scheduled' }
  if (input.held) return { kind: 'held' }
  if (input.busy) return { kind: 'busy' }
  if (input.parent && input.parent.task?.status !== 'active') {
    return { kind: 'parent', parentId: input.parent.id, status: input.parent.task?.status ?? null }
  }
  const open = input.deps.filter((d) => d.task?.status !== 'resolved')
  if (open.length > 0) {
    const first = open[0]
    return { kind: 'depends', stepId: first.id, title: first.task ? nameOf(first.task) : null, status: first.task?.status ?? null, more: open.length - 1 }
  }
  if (input.running >= MAX_RUNNING) return { kind: 'cap', running: input.running, max: MAX_RUNNING, standalone: input.parent === undefined }
  if (!task.scope.startsWith('project.')) return { kind: 'no_project', scope: task.scope }
  if (!runsHere(input.shared, task, input.me)) return { kind: 'other_member', owner: ownerOf(task) }
  return null
}
