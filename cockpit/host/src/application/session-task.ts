import { EmlApiError, type EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace, BrainSpaces } from '../brain-space.js'
import { brainIdFromProjectId } from '../project-registry.js'
import type { SessionLedger } from '../session-ledger.js'
import { LEAD_HANDOFF } from '../domain/project-lead.js'
import { MAX_RUNNING } from '../domain/runner-gate.js'
import { parentOf } from '../domain/task-relations.js'
import { DISPLAY_TITLE_MAX, displayTitleOf, kebabTitle, PLACEHOLDER_TITLE } from '../domain/task-title.js'

/**
 * Task system, phase 1 (note task-system-phase-1-build-plan): every session
 * works on a brain task, in every space.
 *
 *   - At session start (task-hook.ts → POST /api/session-task) a session
 *     without a task gets one: a placeholder named after the session. A
 *     worker's task is its own; it is a step of the requester's task only when
 *     the requester asked for that (spawn --step). Who started it is noted.
 *     A job's session works on the job's task instead.
 *   - A session is called by its task: the
 *     heading, the sidebar and the chat show the task's name. When the session
 *     names itself (session-title-cli.ts), only a placeholder takes that name;
 *     a task with a name keeps it. The user renaming the session renames the task.
 *   - Every start, the session reads its task and the handoff it ends with.
 *
 * In a shared space each member's cockpit acts for its own sessions only: the
 * tasks it creates and reads are those of its ledger's sessions.
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
  properties?: { stage?: string; checkpoint?: string; depends_on?: string[]; goal?: string; delegate?: string; display_title?: string }
  relations?: Array<{ relation: string; source_id: string; target_id: string }>
}

/**
 * One session does a task from start to end; a sub-task only for truly separate work, and it
 * stands on its own. Every session reads it, workers included.
 */
export const SPLIT_RULES = [
  '## Splitting work',
  '- One session does this task from start to end. Work with several parts stays here and you do them in order: sequential work, and work that touches the same files as yours or needs your results along the way.',
  '- Make a sub-task (eml_create_task with parent_id) only for truly separate work: it has its own goal, its own result that can be checked without the rest, and ideally files that no other open step touches. If that does not hold, keep the work here.',
  '- Two steps that would change the same files do not run in parallel: chain them (depends_on) or make them one step.',
  '- A sub-task stands on its own, because a fresh session reads only the sub-task: a goal (one checkable sentence), and content in the brief shape (Came up in · Decided so far · Open questions · Files, links, ids · Not to redo), plus depends_on, checkpoint and delegate.',
  `- At most ${MAX_RUNNING} steps of one task run at the same time, and ${MAX_RUNNING} tasks without a parent per space; further ones wait. Plan a few steps that are each worth a session, not many small ones.`,
]

/** A worker has nobody to offer a split to: new work goes into its handoff. */
export const WORKER_NEW_WORK_RULE = '- New work that is not part of this task: do not start it and do not create a task for it. Name it in the handoff as a [task] question.'

type Parent = Pick<Task, 'id' | 'title' | 'properties'>

/** A task nobody has named yet: the cockpit's placeholder anchor and no display title. */
const isPlaceholder = (task: Pick<Task, 'title' | 'properties'>) => task.title !== null && PLACEHOLDER_TITLE.test(task.title) && !task.properties?.display_title

export const placeholderTitle = (sessionId: string, now: Date) =>
  `session-${now.toISOString().slice(0, 10)}-${sessionId.replace(/-/g, '').slice(0, 8)}`

export { displayTitleOf, kebabTitle }

/** What the session reads at every start: its task, the rules of the task system and the handoff it ends with. */
export function taskContext(task: Task, placeholder: boolean, unattended = false, parent: Parent | null = null): string {
  const state = [task.status, task.properties?.stage, task.properties?.checkpoint ? `checkpoint ${task.properties.checkpoint}` : null, task.properties?.delegate ? `delegate ${task.properties.delegate}` : null].filter(Boolean).join(' · ')
  return [
    '# Your task (cockpit task system)',
    task.properties?.display_title
      ? `This session works on task **${task.properties.display_title}** (${task.title ?? task.id} · ${task.id}) [${state}]`
      : `This session works on task **${task.title ?? task.id}** · ${task.id} [${state}]`,
    task.content,
    task.properties?.goal
      ? `Goal: ${task.properties.goal}`
      : 'Goal: not set yet. Propose one checkable sentence for when this task is done and set it (eml_track_task goal).',
    ...(parent ? [`Step of **${parent.properties?.display_title ?? parent.title ?? parent.id}** (${parent.id}).${parent.properties?.goal ? ` Parent goal: ${parent.properties.goal}` : ''}`] : []),
    ...(task.properties?.display_title && !placeholder ? [] : [
      'Name: as soon as the goal is clear, give the task the name people read in their lists with eml_track_task display_title: verb + object + scope, about 60 characters, the customer or product named, the distinguishing words first (e.g. "Fix missing stock answers in Acme\'s chat assistant", not "acme-stock" or "Session 23 Nov").',
    ]),
    ...(placeholder ? [
      '',
      'The cockpit created this task for the session with a placeholder name; give it its name as above.',
      'If the work belongs to an open task that already exists, tell the user and propose to continue there instead.',
    ] : []),
    'The cockpit calls this session by its task\'s name (heading, sidebar, chat): it has no name of its own. Name or rename the task with eml_track_task display_title; the session follows.',
    '',
    '## Rules',
    '- Progress, plans and decisions of this session go to this task: eml_track_task, eml_note / eml_decide with task_id.',
    '- A worker you start gets a task of its own by default. Name its task when it has one: spawn with --task <id> (an existing task, e.g. the customer\'s open task) or --step (a new step of this task, only when it is part of this task\'s own work).',
    '- Handing out work (an inbox): find the open task it belongs to (eml_list, eml_recall) and start the worker with --task on it; when there is none, start it with --new-task "<title>" --in <the customer\'s or topic\'s project> --task-text "<what needs doing>".',
    '- A task has an owner and may have a delegate: assignee_ids names the person who owns it (Lasse for his work), delegate the one agent that works on it. Handing work to an agent sets delegate; the owner stays. Never put an agent into assignee_ids.',
    '- Planned steps of this task: eml_create_task with parent_id, depends_on, checkpoint (before · after · none) and delegate (your agent handle); the runner starts them.',
    '- A task you create that an agent can do gets a checkpoint (default after; before when it needs the user\'s OK first) and a delegate: the runner starts it, also as a standalone task. Leave both out only when the person does it themselves or the user says so. Name the checkpoint and delegate you set in your reply.',
    '- A step is done when it is closed: eml_track_task with status resolved and the outcome. The runner then starts the steps that depend on it; a step with checkpoint none starts on its own, so plan with care.',
    '- Closing: a task with checkpoint before or after you never close on your own. Hand the finished work over for review (session_status review and the handoff\'s Result); its owner closes it, or tells you explicitly in the chat to close it, and only then you do. Code work is ready for review only once it runs in the user\'s cockpit (merged, released and installed), not when its PR is open or merged. A task with checkpoint none, or one an agent owns, you close yourself when it is done.',
    '- Outputs (texts, drafts, results) go into the brain only when the task asks for it.',
    '- You do not set who has to act next; the cockpit reads your handoff and does that.',
    '- When the work drifts from the task\'s name (the scope changed), rename it: eml_track_task display_title, with text saying why. The journal keeps the old name; the kebab title stays.',
    ...(unattended ? [] : [
      '- New work the user brings up that is not part of this task: offer to split it off before you start on it, once per topic; do not create a task for it yourself. In the chat call offer_split (name the open task it belongs to, if one exists); in a terminal ask in one line whether to split it off (the user does it from the chat view). If they keep it here, carry on and do not offer it again.',
      '- Steps of this task\'s own work, and a task the user explicitly asks you to note, you create yourself; the chat shows each new task to the user with Undo.',
    ]),
    ...(unattended ? [WORKER_NEW_WORK_RULE] : []),
    '',
    ...SPLIT_RULES,
    ...(unattended ? [
      '',
      '## Until it is done',
      '- At every wake-up, check the task against its goal first. Checks are read-only; nothing goes out without the user\'s OK.',
      '- Reached: hand the result over for review (session_status review and the handoff\'s Result). Do not close it yourself.',
      '- Not reached: schedule your next check yourself with the schedule tool (create with at and task_id of this task, or update the job you run in), then stop quietly: session_status done, Next names the time of the check, no [lasse] question. You decide whether and when to check again; do not ask the user about it.',
      '- Ask the user ([lasse]) only what only they can decide. A stop without a next step (a check, a question, a review hand-over, or the task closed) is caught by the cockpit.',
    ] : []),
    '',
    '## Handoff',
    unattended
      ? 'When you stop (done, or waiting for someone), end your last message with this block (leave out lines that are empty):'
      : 'A reply that ends with a question for the user: call session_status question first, with the question as the reason, so it reaches their Inbox; then write your full answer as visible text, ending with the question, because the user reads only that, never the status call or your thinking (in a terminal without that tool, end with the handoff\'s Questions line instead). Do not end every reply with the handoff: the user reads along. Write it only when you hand the task over for review or close it, or when the cockpit asks for it before it stops the session (leave out lines that are empty):',
    '```',
    '### Handoff',
    'Result: <first sentence, at most 100 characters: where the task stands now — the cockpit shows it under the task\'s name in every list; then more if needed>',
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
  /** The context a session's start hook prints; empty for an unknown session or a space without a bound agent. Creates the task when there is none. */
  context(sessionId: string): Promise<string>
  /** The session named itself: a placeholder task takes the name. */
  named(sessionId: string, title: string): Promise<void>
  /** The user renamed the session: its task takes the name, with one journal entry per change. False when the session has no task here; throws when the brain refuses (renameRefusal maps it). */
  renamed(sessionId: string, title: string): Promise<boolean>
  /** Before an idle stop: the prompt asking for the handoff, or null (no brain, no task, or unattended: it hands off every turn). */
  handoffBeforeStop(sessionId: string): string | null
}

/**
 * Why a session's rename did not reach its task, as the page gets it: whether trying again can help, and nothing of
 * the brain's own wording. Nothing was changed in any of these cases.
 */
export function renameRefusal(err: unknown): { status: number; code: string; message: string } {
  const status = err instanceof EmlApiError ? err.status : 0
  if (status === 404) return { status: 404, code: 'TASK_NOT_FOUND', message: 'The session\'s task no longer exists. Nothing was changed.' }
  if (status >= 400 && status < 500) return { status: 422, code: 'TASK_NAME_REFUSED', message: 'The brain does not take this name for the task. Nothing was changed.' }
  return { status: 502, code: 'BRAIN_UNAVAILABLE', message: 'The brain did not answer. Nothing was changed; try again.' }
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
      content: `The work of cockpit session ${sessionId}; the task gets its name once the work is clear.${from}`,
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
    // The anchor is the name as kebab, cut short; the name people read is the session's whole name.
    const display = displayTitleOf(title)
    await brain.post(`/task/${task.id}/track`, { title: name, ...(display ? { display_title: display } : {}), content: `${title} (cockpit session ${sessionId}).`, text: 'Named after its session.' })
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
      let task = await t.brain.get(`/engram/${taskId}`, { with_relations: 'true' }) as Task
      // A session that has a name already (it named itself before its task was made) lends it now.
      const name = t.entry.title ?? t.entry.agentTitle
      if (name && isPlaceholder(task) && deps.ledger.get(sessionId)?.taskAuto) {
        await rename(task, name, sessionId, t.brain)
        task = await t.brain.get(`/engram/${taskId}`, { with_relations: 'true' }) as Task
      }
      // A step reads its parent's name and goal; a parent it cannot read is left out.
      const parentId = parentOf(task)
      const parent = parentId ? await (t.brain.get(`/engram/${parentId}`) as Promise<Task>).catch(() => null) : null
      return taskContext(task, isPlaceholder(task), deps.ledger.get(sessionId)?.worker === true, parent)
    },

    async renamed(sessionId, title) {
      const t = target(sessionId)
      if (!t?.entry.taskId) return false
      const display = displayTitleOf(title) ?? title.replace(/\s+/g, ' ').trim().slice(0, DISPLAY_TITLE_MAX)
      if (!display) return false
      const task = await t.brain.get(`/engram/${t.entry.taskId}`) as Task
      // A placeholder also loses its anchor, so the session's own naming no longer counts it as unnamed.
      const anchor = isPlaceholder(task) ? kebabTitle(title) : null
      // The same name again (a second click, a retry after a timeout) writes nothing.
      if (!anchor && task.properties?.display_title === display) return true
      await t.brain.post(`/task/${task.id}/track`, { display_title: display, ...(anchor ? { title: anchor } : {}), text: 'Renamed from its session\'s heading in the cockpit.' })
      return true
    },

    async named(sessionId, title) {
      const t = target(sessionId)
      if (!t?.entry.taskId || !t.entry.taskAuto) return
      const task = await t.brain.get(`/engram/${t.entry.taskId}`) as Task
      // The session or the user named it already: theirs stays, and the session's own name is not used.
      if (!isPlaceholder(task)) return
      await rename(task, title, sessionId, t.brain)
    },
  }
}
