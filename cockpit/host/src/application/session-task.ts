import type { EmlApi } from '@engramprotocol/mcp-server'
import { taskSystemOn, type BrainSpace, type BrainSpaces } from '../brain-space.js'
import { brainIdFromProjectId } from '../project-registry.js'
import type { SessionLedger } from '../session-ledger.js'
import { LEAD_HANDOFF } from '../domain/project-lead.js'

/**
 * Task system, phase 1 (note task-system-phase-1-build-plan): every session in
 * a space that switched it on works on a brain task.
 *
 *   - At session start (task-hook.ts → POST /api/session-task) a session
 *     without a task gets one: a placeholder named after the session. A
 *     worker's task is its own; it is a step of the requester's task only when
 *     the requester asked for that (spawn --step). Who started it is noted.
 *     A job's session works on the job's task instead.
 *   - When the session names itself (session-title-cli.ts), the placeholder
 *     takes that name, unless the session already renamed the task.
 *   - Every start, the session reads its task and the handoff it ends with.
 *
 * Off (a shared space, an unconfirmed one, or the switch off): no task is
 * created and the hook prints nothing — the session runs as before.
 */

export interface SessionTaskDeps {
  ledger: Pick<SessionLedger, 'get' | 'setTask' | 'expectedTaskParent' | 'claimLead'>
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
  properties?: { stage?: string; checkpoint?: string; depends_on?: string[]; goal?: string; delegate?: string }
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
export function taskContext(task: Task, placeholder: boolean, unattended = false): string {
  const state = [task.status, task.properties?.stage, task.properties?.checkpoint ? `checkpoint ${task.properties.checkpoint}` : null, task.properties?.delegate ? `delegate ${task.properties.delegate}` : null].filter(Boolean).join(' · ')
  return [
    '# Your task (cockpit task system)',
    `This session works on task **${task.title ?? task.id}** · ${task.id} [${state}]`,
    task.content,
    task.properties?.goal
      ? `Goal: ${task.properties.goal}`
      : 'Goal: not set yet. Propose one checkable sentence for when this task is done and set it (eml_track_task goal).',
    ...(placeholder ? [
      '',
      'The cockpit created this task for the session; it takes the session\'s name once you name the session.',
      'If the work belongs to an open task that already exists, tell the user and propose to continue there instead.',
    ] : []),
    '',
    '## Rules',
    '- Progress, plans and decisions of this session go to this task: eml_track_task, eml_note / eml_decide with task_id.',
    '- A worker you start gets a task of its own by default. Name its task when it has one: spawn with --task <id> (an existing task, e.g. the customer\'s open task) or --step (a new step of this task, only when it is part of this task\'s own work).',
    '- Handing out work (an inbox): find the open task it belongs to (eml_list, eml_recall) and start the worker with --task on it; when there is none, start it with --new-task "<title>" --in <the customer\'s or topic\'s project> --task-text "<what needs doing>".',
    '- A task has an owner and may have a delegate: assignee_ids names the person who owns it (Lasse for his work), delegate the one agent that works on it. Handing work to an agent sets delegate; the owner stays. Never put an agent into assignee_ids.',
    '- Planned steps of this task: eml_create_task with parent_id, depends_on, checkpoint (before · after · none) and delegate (your agent handle); the runner starts them.',
    '- A task you create that an agent can do gets a checkpoint (default after; before when it needs the user\'s OK first) and a delegate: the runner starts it, also as a standalone task. Leave both out only when the person does it themselves or the user says so. Name the checkpoint and delegate you set in your reply.',
    '- A step is done when you close it: eml_track_task with status resolved and the outcome. A task with checkpoint after you only close once the user has reviewed the result. The runner then starts the steps that depend on it; a step with checkpoint none starts on its own, so plan with care.',
    '- Outputs (texts, drafts, results) go into the brain only when the task asks for it.',
    '- You do not set who has to act next; the cockpit reads your handoff and does that.',
    ...(unattended ? [
      '',
      '## Until it is done',
      '- At every wake-up, check the task against its goal first. Checks are read-only; nothing goes out without the user\'s OK.',
      '- Reached: hand the result over for review (session_status review and the handoff\'s Result). Do not close it yourself.',
      '- Not reached: schedule your next check yourself with the schedule tool (create with at and task_id of this task, or update the job you run in), then stop quietly: session_status done, Next names the time of the check, no [lasse] question. You decide whether and when to check again; do not ask the user about it.',
      '- Ask the user ([lasse]) only what only they can decide. A stop without a next step (a check, a question, or the task closed) is caught by the cockpit.',
    ] : []),
    '',
    '## Handoff',
    unattended
      ? 'When you stop (done, or waiting for someone), end your last message with this block (leave out lines that are empty):'
      : 'Do not end every reply with it: the user reads along. Write it only when you close the task, or when the cockpit asks for it before it stops the session (leave out lines that are empty):',
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
  /** Before an idle stop: the prompt asking for the handoff, or null (task system off, no task, or unattended: it hands off every turn). */
  handoffBeforeStop(sessionId: string): string | null
}

export const HANDOFF_BEFORE_STOP = 'The cockpit is about to stop this session because nobody has used it for a while. Before it does, write your handoff block now (### Handoff with Result, Checked · Claimed, Decided, Next, Questions). Put anything only the user can answer under Questions as [lasse]. Nothing else; the session stops after this reply.'

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
    const parentTask = deps.ledger.expectedTaskParent(sessionId)
    const requester = entry.parentSessionId ? deps.ledger.get(entry.parentSessionId) : undefined
    const brainId = entry.projectId ? brainIdFromProjectId(entry.projectId) : null
    // Where it came from is history, not structure: noted, not a parent task.
    const from = entry.parentSessionId
      ? ` Started by session ${requester?.title ?? requester?.agentTitle ?? entry.parentSessionId}${requester?.taskId ? ` (its task ${requester.taskId})` : ''}.`
      : ''
    const body = {
      title: placeholderTitle(sessionId, now()),
      content: `The work of cockpit session ${sessionId}; the task takes the session's name once it has one.${from}`,
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
    await brain.post(`/task/${task.id}/track`, { title: name, content: `${title} (cockpit session ${sessionId}).`, text: 'Named after its session.' })
  }

  return {
    handoffBeforeStop(sessionId) {
      // A project lead leaves the project's status, in any space; the cycle planner's work is in the tasks already.
      const lead = deps.ledger.claimLead(sessionId)
      if (lead) return lead.projectId.startsWith('cycle:') ? null : LEAD_HANDOFF
      const t = target(sessionId)
      if (!t?.entry.taskId || t.entry.worker) return null
      return HANDOFF_BEFORE_STOP
    },

    async context(sessionId) {
      // A project lead works on no task of its own: its first message says what it does.
      if (deps.ledger.claimLead(sessionId)) return ''
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
      return taskContext(task, task.title !== null && PLACEHOLDER.test(task.title), deps.ledger.get(sessionId)?.worker === true)
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
