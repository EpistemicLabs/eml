import type { EmlApi } from '@engramprotocol/mcp-server'
import { taskSystemOn, type BrainSpace, type BrainSpaces } from '../brain-space.js'
import { brainIdFromProjectId } from '../project-registry.js'
import type { SessionLedger } from '../session-ledger.js'

/**
 * Task system, phase 1 (note task-system-phase-1-build-plan): every session in
 * a space that switched it on works on a brain task.
 *
 *   - At session start (task-hook.ts → POST /api/session-task) a session
 *     without a task gets one: a placeholder named after the session, a
 *     sub-task of its parent session's task when another session opened it.
 *     A job's session works on the job's task instead.
 *   - When the session names itself (session-title-cli.ts), the placeholder
 *     takes that name, unless the session already renamed the task.
 *   - Every start, the session reads its task and the handoff it ends with.
 *
 * Off (a shared space, an unconfirmed one, or the switch off): no task is
 * created and the hook prints nothing — the session runs as before.
 */

export interface SessionTaskDeps {
  ledger: Pick<SessionLedger, 'get' | 'setTask'>
  spaces: Pick<BrainSpaces, 'resolve'>
  /** The brain as the space's sessions see it (brain-mcp.ts sessionClient); null when the space has no agent. */
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /** The task a job is attached to (domain/job.ts taskId): a run of the job works on it. */
  jobTask?: (jobId: string) => string | null
  now?: () => Date
}

interface Task {
  id: string
  title: string | null
  content: string
  status: string
  properties?: { stage?: string; checkpoint?: string; depends_on?: string[] }
}

/** The name a task gets before its session has one. */
const PLACEHOLDER = /^session-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/

export const placeholderTitle = (sessionId: string, now: Date) =>
  `session-${now.toISOString().slice(0, 10)}-${sessionId.replace(/-/g, '').slice(0, 8)}`

/** A session title as a task's kebab-case anchor; null when nothing usable is left. */
export function kebabTitle(title: string): string | null {
  const kebab = title
    .replace(/ß/g, 'ss').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '')
  return kebab.length >= 3 ? kebab : null
}

/** What the session reads at every start: its task, the rules of the task system and the handoff it ends with. */
export function taskContext(task: Task, placeholder: boolean): string {
  const state = [task.status, task.properties?.stage, task.properties?.checkpoint ? `checkpoint ${task.properties.checkpoint}` : null].filter(Boolean).join(' · ')
  return [
    '# Your task (cockpit task system)',
    `This session works on task **${task.title ?? task.id}** · ${task.id} [${state}]`,
    task.content,
    ...(placeholder ? [
      '',
      'The cockpit created this task for the session; it takes the session\'s name once you name the session.',
      'If the work belongs to an open task that already exists, tell the user and propose to continue there instead.',
    ] : []),
    '',
    '## Rules',
    '- Progress, plans and decisions of this session go to this task: eml_track_task, eml_note / eml_decide with task_id.',
    '- Work for another session is a step of this task: eml_create_task with parent_id, depends_on and checkpoint (before · after · none). Do not start sessions for work that has no task.',
    '- A step is done when you close it: eml_track_task with status resolved and the outcome. The runner then starts the steps that depend on it; a step with checkpoint none starts on its own, so plan with care.',
    '- Outputs (texts, drafts, results) go into the brain only when the task asks for it.',
    '- You do not set who has to act next; the cockpit reads your handoff and does that.',
    '',
    '## Handoff',
    'When you stop — done, or waiting for someone — end your last message with this block (leave out lines that are empty):',
    '```',
    '### Handoff',
    'Result: <what came out, in one or two sentences>',
    'Checked: <what you verified yourself> · Claimed: <what you took over unverified>',
    'Decided: <decisions made in this session>',
    'Next: <the next step, and who takes it>',
    'Questions:',
    '- [lasse] <a question only the user can answer>',
    '- [task] <an open question for the task>',
    '```',
  ].join('\n')
}

export interface SessionTask {
  /** The context a session's start hook prints; empty when the task system is off for it. Creates the task when there is none. */
  context(sessionId: string): Promise<string>
  /** The session named itself: a placeholder task takes the name. */
  named(sessionId: string, title: string): Promise<void>
}

export function createSessionTask(deps: SessionTaskDeps): SessionTask {
  const now = () => deps.now?.() ?? new Date()
  // One creation per session, also when two starts race (startup and a quick resume).
  const creating = new Map<string, Promise<string | null>>()

  const target = (sessionId: string) => {
    const entry = deps.ledger.get(sessionId)
    if (!entry) return null
    const space = deps.spaces.resolve(entry.spaceId)
    if (!taskSystemOn(space)) return null
    const brain = deps.brain(space)
    return brain ? { entry, brain } : null
  }

  const create = async (sessionId: string, brain: Pick<EmlApi, 'post'>): Promise<string | null> => {
    const entry = deps.ledger.get(sessionId)!
    const parentTask = entry.parentSessionId ? deps.ledger.get(entry.parentSessionId)?.taskId ?? null : null
    const brainId = entry.projectId ? brainIdFromProjectId(entry.projectId) : null
    const body = {
      title: placeholderTitle(sessionId, now()),
      content: `The work of cockpit session ${sessionId}; the task takes the session's name once it has one.`,
      status: 'active',
      ...(parentTask ? { parent_id: parentTask } : {}),
    }
    const post = (scope: string) => brain.post('/engram/task', { ...body, scope }) as Promise<Task>
    // A project the brain does not know refuses the scope; the task then lives in global.
    const task = brainId ? await post(`project.${brainId}`).catch(() => post('global')) : await post('global')
    deps.ledger.setTask(sessionId, task.id, true)
    return task.id
  }

  const rename = async (task: Task, title: string, sessionId: string, brain: Pick<EmlApi, 'post'>) => {
    const name = kebabTitle(title)
    if (!name) return
    await brain.post(`/task/${task.id}/track`, { title: name, content: `${title} (cockpit session ${sessionId}).` })
  }

  return {
    async context(sessionId) {
      const t = target(sessionId)
      if (!t) return ''
      let taskId = t.entry.taskId
      const jobTask = !taskId && t.entry.jobId ? deps.jobTask?.(t.entry.jobId) ?? null : null
      if (jobTask) {
        deps.ledger.setTask(sessionId, jobTask)
        taskId = jobTask
      }
      if (!taskId) {
        const running = creating.get(sessionId) ?? create(sessionId, t.brain).finally(() => creating.delete(sessionId))
        creating.set(sessionId, running)
        taskId = await running
      }
      if (!taskId) return ''
      let task = await t.brain.get(`/engram/${taskId}`) as Task
      // A session that has a name already (it named itself before the task system was on) lends it now.
      const name = t.entry.title ?? t.entry.agentTitle
      if (name && task.title && PLACEHOLDER.test(task.title) && deps.ledger.get(sessionId)?.taskAuto) {
        await rename(task, name, sessionId, t.brain)
        task = await t.brain.get(`/engram/${taskId}`) as Task
      }
      return taskContext(task, task.title !== null && PLACEHOLDER.test(task.title))
    },

    async named(sessionId, title) {
      const t = target(sessionId)
      if (!t?.entry.taskId || !t.entry.taskAuto) return
      const task = await t.brain.get(`/engram/${t.entry.taskId}`) as Task
      // The session or the user renamed it already: theirs stays.
      if (!task.title || !PLACEHOLDER.test(task.title)) return
      await rename(task, title, sessionId, t.brain)
    },
  }
}
