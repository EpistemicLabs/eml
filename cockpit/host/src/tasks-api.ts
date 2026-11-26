import type * as http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { TaskBoard } from './application/task-board.js'
import { SCHEDULE_ON, type CommandInput, type CommandRefusal, type Submitted, type TaskCommands } from './application/task-commands.js'
import type { SplitBrief } from './application/split-brief.js'
import type { SplitAnswer, SplitSession } from './application/split-session.js'
import type { SortSession } from './application/sort-session.js'
import { SORT_PICKS, type SortPick, type SortRow } from './domain/sort.js'
import { HAND_OVER_MODES, readScheduleSpec, type HandOverMode } from './domain/hand-over.js'
import { GRANT_TOOLS, JOB_LIMITS, type GrantTool } from './domain/job.js'
import { CHANNELS } from './domain/job-contract.js'
import { GRANT_MINUTES, type RecordAnswer, type RecordRefusal, type TaskRecords } from './application/task-record.js'
import { SPLIT_RELATIONS, SPLIT_WHENS, type SplitRelation, type SplitWhen } from './domain/split.js'
import type { TaskStateMigration } from './application/task-state-migration.js'

/**
 * The task board over HTTP, versioned (decision cockpit-host-routes-versioned-from-now). Page only:
 * the same-origin guard holds the writes.
 *   GET  /api/v1/tasks/board                        the board (application/task-board.ts)
 *   GET  /api/v1/tasks/closed?spaceId&project&limit  a project's newest closed tasks, done and dropped: { tasks, more }
 *   POST /api/v1/tasks/<id>/hand-over               { opId, spaceId, mode, delegate, checkpoint, schedule?, desk?, fresh? }: fresh true:
 *                                                     Delegate now starts a new session instead of continuing the task's
 *                                                     own one; mode together on a task with its own session is Take over
 *                                                     (no desk needed); refused (not_ready) on a task without a name or goal,
 *                                                     (no_session) without a desk when the task has no session to take over
 *   POST /api/v1/tasks/<id>/review                  { opId, spaceId }: Looks good, done; on a task whose schedule is on it approves
 *                                                     that run and the task stays open
 *   POST /api/v1/tasks/<id>/snooze                  { opId, spaceId, key, until }
 *   POST /api/v1/tasks/<id>/close                   { opId, spaceId }: drop a task that is not needed; refused (scheduled) while its
 *                                                     schedule is on
 *   POST /api/v1/tasks/<id>/end-schedule            { opId, spaceId }: End schedule and close: the owner clears the task's schedule
 *                                                     and the task closes as done; refused (not_scheduled) without a schedule
 *   POST /api/v1/tasks/<id>/pause-schedule          { opId, spaceId }: the owner pauses the task's whole schedule; refused (not_scheduled)
 *                                                     without one. It acts at once, like the next three: no undo window
 *   POST /api/v1/tasks/<id>/resume-schedule         { opId, spaceId }: the schedule goes on from now; also lifts a pause the cockpit
 *                                                     set after failed runs
 *   POST /api/v1/tasks/<id>/run-now                 { opId, spaceId }: a run now, by the four-line order; refused (run_open) while its
 *                                                     last run is open, (task_working) while a session of the task works,
 *                                                     (needs_approval) while its channel waits for the user's OK
 *   POST /api/v1/tasks/<id>/remove-time             { opId, spaceId, cron }: remove one repeating time; refused (unknown_time) when the
 *                                                     schedule has none such. Removing the only time ends the schedule; the task stays open
 *   GET  /api/v1/tasks/<id>/record?spaceId          what this cockpit keeps for the task (domain/job.ts): { record, runs, held, running };
 *                                                     record null when it keeps nothing
 *   POST /api/v1/tasks/<id>/record/approve          { spaceId }: the user's OK for new channel addresses
 *   POST /api/v1/tasks/<id>/record/reply            { spaceId, channel, mode }: send or draft per channel
 *   POST /api/v1/tasks/<id>/record/limited          { spaceId, limited }: the Limited switch (makes the record when there is none)
 *   POST /api/v1/tasks/<id>/record/grant            { spaceId, tool, minutes?, reason? }: lend a tool for a while
 *   POST /api/v1/tasks/<id>/record/revoke           { spaceId, tool }: take it back
 *                                                     Each answers 200 { text, record }, or a refusal (no_record without a record)
 *   POST /api/v1/tasks/<id>/reopen                  { opId, spaceId, reason?, message? }: the owner reopens a closed task (active;
 *                                                     starts nothing, or with a message: its newest session gets it)
 *   POST /api/v1/tasks/<id>/follow-up               { opId, spaceId, message }: a new task spun off from this one, the message its brief
 *   POST /api/v1/sessions/<id>/split                { opId, title, brief, relation, when, projectId, existingTaskId? }: split a topic off a session (onto an open task, with existingTaskId)
 *   POST /api/v1/sessions/<id>/split-brief          { upTo?, contextOnly? }: a draft (title, relation, projectId, brief) from the turns up to a message; contextOnly: only the dialog's context, no model call
 *   POST /api/v1/sessions/<id>/sort                 { opId, rows: [{ topic, pick, taskId?, brief? }] }: sort a drifted session
 *   POST /api/v1/tasks/<id>/start                   { spaceId, projectId?, prompt?, title?, deskId? }: a session of the user's own on the task (chat when that is their view)
 *   POST /api/v1/commands/<opId>/undo
 * A command answers 202 { opId, state, undoUntil, carriedQuestion?, brief?, effects?, sessionId? }; Work on it now
 * and Take over happen at once: the page opens a new session in its desk with the brief, or for a Take over the
 * task's own session (sessionId) where it is shown or in the desk named. A refusal answers
 * { error: { code, message, retry } }: the code is what the page branches on, retry whether trying
 * again can help.
 */

export interface TasksApiDeps {
  board: TaskBoard
  commands: TaskCommands
  split: SplitSession
  brief: SplitBrief
  sort: SortSession
  /** The user's per-machine settings of a scheduled task (application/task-record.ts). Without it the record routes answer 404. */
  records?: TaskRecords
  /** The task state migration (application/task-state-migration.ts): a dry run, then the run. */
  migration?: TaskStateMigration
  /** Start a session of the user's own on a task: the host binds the task, the page opens the pane (in chat when that is the user's view). */
  startOnTask(input: { spaceId: string; taskId: string; projectId?: string; prompt?: string; title?: string; deskId?: string }): Promise<
    { ok: true; sessionId: string } | { ok: false; refusal: 'unknown_space' | 'unknown_task' | 'task_closed' | 'no_project'; message?: string }
  >
  /** The time a hand-over's schedule is checked against; the clock without it. */
  now?(): number
}

type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>

/** How old a board the page may get before it is rebuilt. */
const BOARD_MAX_AGE_MS = 5000

const MESSAGES: Record<CommandRefusal, string> = {
  invalid: 'The request is missing a field or has one it cannot use.',
  unknown_space: 'No such space.',
  unknown_task: 'No such task in this space.',
  no_brain: 'The space has no brain to write to right now.',
  task_closed: 'The task is closed.',
  delegate_not_in_space: 'That agent does not work in this space.',
  checkpoint_required: 'Pick a checkpoint: before, after or none.',
  not_ready: 'Give the task a name and a goal first: an agent working on it alone needs to know what done means.',
  schedule_required: 'Pick when the agent starts.',
  schedule_invalid: 'That time cannot be added to its schedule: a task holds at most 10 repeating times.',
  no_session: 'The task has no open session to take over: pick a desk to start one.',
  bound_items: 'Decisions or notes are bound to this task: close it in the chat, which asks which of them stay.',
  open_steps: 'This task still has open steps: close or move them first.',
  task_open: 'The task is open already.',
  not_owner: 'Only the task\'s owner can reopen it.',
  superseded: 'Another task replaced this one: go on there.',
  parent_closed: 'Its parent is closed: reopen the parent first.',
  scheduled: SCHEDULE_ON,
  not_scheduled: 'It has no schedule to end: close it instead.',
  unknown_time: 'Its schedule has no such repeating time.',
  run_open: 'Its last run is still going: wait for it to finish.',
  task_working: 'A session of the task is working right now: nothing is started beside it.',
  needs_approval: 'Its channel waits for your OK first.',
  unknown_command: 'No such action to undo.',
  undo_expired: 'Too late to undo: the action already happened.',
}

type SplitRefusalCode = Extract<SplitAnswer, { ok: false }>['refusal']

const SPLIT_MESSAGES: Record<SplitRefusalCode, string> = {
  invalid: 'The split needs an opId, a title, a brief, how it relates (spun · sub · unrelated) and when (now · park).',
  sub_needs_task: 'A sub-task needs a task to hang under, and this session has none.',
  no_project: 'The new task needs a project of the brain, and this session has none: pick a project for it.',
  unknown_session: 'No such session.',
  unknown_project: 'No such project in this session\'s space.',
  unknown_task: 'That task is not open (or not in this space).',
  no_brain: 'The space has no brain to write to right now.',
  unknown_command: 'No such action to undo.',
  undo_expired: 'Too late to undo the split.',
  in_flight: 'This split is still running.',
}

const SPLIT_STATUS: Partial<Record<SplitRefusalCode, number>> = {
  unknown_session: 404, unknown_project: 404, unknown_task: 404, unknown_command: 404, sub_needs_task: 409, no_project: 409, undo_expired: 409, in_flight: 409, no_brain: 503,
}

function refuseSplit(json: Json, res: http.ServerResponse, refusal: SplitRefusalCode): void {
  json(res, SPLIT_STATUS[refusal] ?? 400, { error: { code: refusal, message: SPLIT_MESSAGES[refusal], retry: refusal === 'no_brain' || refusal === 'in_flight' } })
}

/** A split or sort that failed part-way: what is done is recorded under its opId, so the same opId again resumes it. */
function failedPartWay(json: Json, res: http.ServerResponse, what: 'split' | 'sort', err: unknown): void {
  json(res, 502, { error: { code: `${what}_failed`, message: `The ${what} stopped part-way (${(err as Error).message}); try again to finish it.`, retry: true } })
}

const STATUS: Partial<Record<CommandRefusal, number>> = {
  unknown_space: 404, unknown_task: 404, unknown_command: 404,
  task_closed: 409, bound_items: 409, open_steps: 409, undo_expired: 409,
  task_open: 409, superseded: 409, parent_closed: 409, not_owner: 403,
  scheduled: 409, not_scheduled: 409, unknown_time: 409, run_open: 409, task_working: 409, needs_approval: 409,
  no_brain: 503,
}

const RECORD_STATUS: Partial<Record<RecordRefusal, number>> = { unknown_space: 404, unknown_task: 404, no_record: 404, task_closed: 409, no_brain: 503 }

function answerRecord(json: Json, res: http.ServerResponse, result: RecordAnswer): void {
  if (result.ok) json(res, 200, { text: result.text, record: result.record })
  else json(res, RECORD_STATUS[result.refusal] ?? 400, { error: { code: result.refusal, message: result.message, retry: result.refusal === 'no_brain' } })
}

function refuse(json: Json, res: http.ServerResponse, refusal: CommandRefusal, message?: string): void {
  json(res, STATUS[refusal] ?? 400, { error: { code: refusal, message: message ?? MESSAGES[refusal], retry: refusal === 'no_brain' } })
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function answer(json: Json, res: http.ServerResponse, result: Submitted): void {
  if (!result.ok) return refuse(json, res, result.refusal, result.message)
  const c = result.command
  json(res, 202, {
    opId: c.opId, state: c.state, undoUntil: c.undoUntil,
    ...(c.carriedQuestion ? { carriedQuestion: c.carriedQuestion } : {}),
    ...(c.brief ? { brief: c.brief } : {}),
    ...(c.effects ? { effects: c.effects } : {}),
    ...(c.tookOver ? { sessionId: c.tookOver } : {}),
  })
}

export async function handleTasksApi(
  req: http.IncomingMessage, res: http.ServerResponse, deps: TasksApiDeps, pathname: string, method: string, json: Json, readJson: ReadJson,
): Promise<boolean> {
  // The task state migration of a space: GET is the dry run (nothing written), POST the run.
  if (pathname === '/api/v1/tasks/migration' && deps.migration && (method === 'GET' || method === 'POST')) {
    const spaceId = method === 'GET' ? str(new URL(req.url ?? '', 'http://host').searchParams.get('spaceId')) : str((await readJson(req)).spaceId)
    if (!spaceId) {
      json(res, 400, { error: { code: 'invalid', message: 'Name the spaceId.', retry: false } })
      return true
    }
    const answer = method === 'GET' ? await deps.migration.dryRun(spaceId) : await deps.migration.run(spaceId)
    if (!answer.ok) {
      if (answer.refusal === 'in_flight') json(res, 409, { error: { code: 'in_flight', message: answer.message, retry: true } })
      else refuse(json, res, answer.refusal)
    } else if ('failed' in answer && answer.failed.length > 0) {
      // Part of it failed: a retry plans again and writes what is left.
      json(res, 502, { error: { code: 'migration_failed', message: `${answer.failed.length} change(s) failed; run it again to write the rest.`, retry: true }, ...answer })
    } else json(res, 200, answer)
    return true
  }

  if (pathname === '/api/v1/tasks/board' && method === 'GET') {
    json(res, 200, await deps.board.get(BOARD_MAX_AGE_MS))
    return true
  }

  if (pathname === '/api/v1/tasks/closed' && method === 'GET') {
    const params = new URL(req.url ?? '', 'http://host').searchParams
    const spaceId = str(params.get('spaceId')), project = str(params.get('project'))
    const limit = Number(params.get('limit'))
    if (!spaceId || !project || !Number.isInteger(limit) || limit < 1) {
      json(res, 400, { error: { code: 'invalid', message: 'Name the spaceId and project, and a whole limit of 1 or more.', retry: false } })
      return true
    }
    const answer = await deps.board.closed(spaceId, project, limit)
    if (answer.ok) json(res, 200, answer.page)
    else if (answer.refusal === 'brain_unavailable') json(res, 502, { error: { code: answer.refusal, message: 'The space\'s brain did not answer; try again.', retry: true } })
    else refuse(json, res, answer.refusal)
    return true
  }

  const undo = /^\/api\/v1\/commands\/([^/]+)\/undo$/.exec(pathname)
  if (undo && method === 'POST') {
    const opId = decodeURIComponent(undo[1])
    if (deps.split.owns(opId)) {
      const result = await deps.split.undo(opId)
      if (!result.ok) refuseSplit(json, res, result.refusal)
      else json(res, 200, { state: 'undone' })
      void deps.board.refresh().catch(() => {})
      return true
    }
    const result = await deps.commands.undo(opId)
    if (!result.ok) refuse(json, res, result.refusal)
    else json(res, 200, { state: 'undone' })
    void deps.board.refresh().catch(() => {})
    return true
  }

  const draft = /^\/api\/v1\/sessions\/([^/]+)\/split-brief$/.exec(pathname)
  if (draft && method === 'POST') {
    const body = await readJson(req)
    const sessionId = decodeURIComponent(draft[1])
    if (body.contextOnly === true) {
      const context = await deps.brief.context(sessionId, str(body.title))
      if (context) json(res, 200, { context })
      else json(res, 404, { error: { code: 'unknown_session', message: 'No such session.', retry: false } })
      return true
    }
    const result = await deps.brief.write(sessionId, str(body.upTo))
    if (result.ok) json(res, 200, { ...result.draft, context: result.context })
    else if (result.reason === 'unknown_session') json(res, 404, { error: { code: 'unknown_session', message: 'No such session.', retry: false } })
    else {
      // The dialog still opens: it gets what it needs to offer the choices, and the person writes the brief.
      const message = result.reason === 'empty' ? 'The session has nothing to write a brief from yet.'
        : result.reason === 'unreadable' ? 'The brief came back unreadable: write it yourself or try again.'
          : `The brief could not be written: ${result.message ?? 'no answer'}`
      json(res, result.reason === 'empty' ? 422 : 502, { error: { code: result.reason === 'failed' ? 'brief_failed' : result.reason, message, retry: result.reason !== 'empty' }, context: result.context })
    }
    return true
  }

  const sort = /^\/api\/v1\/sessions\/([^/]+)\/sort$/.exec(pathname)
  if (sort && method === 'POST') {
    const body = await readJson(req)
    const raw = Array.isArray(body.rows) ? body.rows as Array<Record<string, unknown>> : null
    const rows: SortRow[] | null = raw && raw.every((r) => typeof r?.topic === 'string' && SORT_PICKS.includes(r.pick as SortPick))
      ? raw.map((r) => ({ topic: String(r.topic), pick: r.pick as SortPick, ...(str(r.taskId) ? { taskId: str(r.taskId) } : {}), ...(str(r.brief) ? { brief: str(r.brief) } : {}) }))
      : null
    const opId = str(body.opId)
    if (!rows || !opId) { json(res, 400, { error: { code: 'invalid', message: `opId and rows (a list of { topic, pick (${SORT_PICKS.join(' · ')}), taskId?, brief? }) are required`, retry: false } }); return true }
    let result: Awaited<ReturnType<SortSession['apply']>>
    try {
      result = await deps.sort.apply({ opId, sessionId: decodeURIComponent(sort[1]), rows })
    } catch (err) {
      failedPartWay(json, res, 'sort', err)
      return true
    }
    if (result.ok) json(res, 200, { opId: result.command.opId, ...result.command.sort })
    else {
      const [status, message] = result.refusal === 'unknown_session' ? [404, 'No such session.']
        : result.refusal === 'no_task' ? [409, 'Sorting needs a task on the session.']
          : result.refusal === 'no_project' ? [409, 'New tasks go into the project of the session\'s task, and it has none: move that task into a project first.']
          : result.refusal === 'in_flight' ? [409, 'This sort is still running.']
            : [503, 'The space has no brain to write to right now.']
      json(res, status, { error: { code: result.refusal, message, retry: result.refusal === 'no_brain' || result.refusal === 'in_flight' } })
    }
    void deps.board.refresh().catch(() => {})
    return true
  }

  const split = /^\/api\/v1\/sessions\/([^/]+)\/split$/.exec(pathname)
  if (split && method === 'POST') {
    const body = await readJson(req)
    const relation = str(body.relation) as SplitRelation | undefined
    const when = str(body.when) as SplitWhen | undefined
    const title = str(body.title), brief = str(body.brief), projectId = str(body.projectId), opId = str(body.opId)
    if (!opId || !title || !brief || !projectId || !relation || !SPLIT_RELATIONS.includes(relation) || !when || !SPLIT_WHENS.includes(when)) {
      refuseSplit(json, res, 'invalid')
      return true
    }
    let result: SplitAnswer
    try {
      result = await deps.split.submit({ opId, sessionId: decodeURIComponent(split[1]), title, brief, relation, when, projectId, ...(str(body.existingTaskId) ? { existingTaskId: str(body.existingTaskId) } : {}) })
    } catch (err) {
      failedPartWay(json, res, 'split', err)
      return true
    }
    if (!result.ok) refuseSplit(json, res, result.refusal)
    else {
      const c = result.command
      json(res, 202, {
        opId: c.opId, state: c.state, undoUntil: c.undoUntil,
        ...(c.split?.createdTaskId ? { taskId: c.split.createdTaskId } : {}),
        ...(c.split?.spawnedSessionId ? { sessionId: c.split.spawnedSessionId } : {}),
      })
    }
    void deps.board.refresh().catch(() => {})
    return true
  }

  const startOn = /^\/api\/v1\/tasks\/([^/]+)\/start$/.exec(pathname)
  if (startOn && method === 'POST') {
    const body = await readJson(req)
    const spaceId = str(body.spaceId)
    if (!spaceId) { json(res, 400, { error: { code: 'invalid', message: 'spaceId is required', retry: false } }); return true }
    const result = await deps.startOnTask({
      spaceId, taskId: decodeURIComponent(startOn[1]),
      ...(str(body.projectId) ? { projectId: str(body.projectId) } : {}),
      ...(str(body.prompt) ? { prompt: str(body.prompt) } : {}),
      ...(str(body.title) ? { title: str(body.title) } : {}),
      ...(str(body.deskId) ? { deskId: str(body.deskId) } : {}),
    })
    if (result.ok) json(res, 202, { sessionId: result.sessionId })
    else {
      const status = result.refusal === 'task_closed' ? 409 : result.refusal === 'no_project' ? 422 : 404
      const message = result.message ?? (result.refusal === 'task_closed' ? 'The task is closed.' : result.refusal === 'no_project' ? 'The task has no project to run in.' : result.refusal === 'unknown_space' ? 'No such space.' : 'No such task in this space.')
      json(res, status, { error: { code: result.refusal, message, retry: false } })
    }
    return true
  }

  // What this cockpit keeps for a scheduled task, and the user's own decisions on it: never reachable from a session's tool.
  const record = /^\/api\/v1\/tasks\/([^/]+)\/record(?:\/(approve|reply|limited|grant|revoke))?$/.exec(pathname)
  if (record && deps.records && ((method === 'GET' && !record[2]) || (method === 'POST' && record[2]))) {
    const taskId = decodeURIComponent(record[1])
    if (method === 'GET') {
      const spaceId = str(new URL(req.url ?? '', 'http://host').searchParams.get('spaceId'))
      if (!spaceId) { json(res, 400, { error: { code: 'invalid', message: 'Name the spaceId.', retry: false } }); return true }
      const view = deps.records.view(spaceId, taskId)
      if ('ok' in view) answerRecord(json, res, view)
      else json(res, 200, view)
      return true
    }
    const body = await readJson(req)
    const spaceId = str(body.spaceId)
    const invalid = (message: string) => { json(res, 400, { error: { code: 'invalid', message, retry: false } }); return true }
    if (!spaceId) return invalid('spaceId is required')
    const action = record[2]
    if (action === 'approve') answerRecord(json, res, deps.records.approve(spaceId, taskId))
    else if (action === 'limited') {
      if (typeof body.limited !== 'boolean') return invalid('limited is true or false')
      answerRecord(json, res, await deps.records.setLimited(spaceId, taskId, body.limited))
    } else if (action === 'grant' || action === 'revoke') {
      const tool = body.tool
      if (!(GRANT_TOOLS as readonly unknown[]).includes(tool)) return invalid(`tool is one of ${GRANT_TOOLS.join(', ')}`)
      answerRecord(json, res, action === 'grant'
        ? deps.records.grant(spaceId, taskId, tool as GrantTool, body.minutes === undefined ? GRANT_MINUTES.default : Number(body.minutes), typeof body.reason === 'string' ? body.reason.slice(0, 200) : null)
        : deps.records.revoke(spaceId, taskId, tool as GrantTool))
    } else {
      const channel = CHANNELS.find((c) => c === body.channel)
      const mode = body.mode
      if (!channel || (mode !== 'send' && mode !== 'draft')) return invalid(`channel is one of ${CHANNELS.join(', ')}; mode is send or draft`)
      answerRecord(json, res, deps.records.setReply(spaceId, taskId, channel, mode))
    }
    void deps.board.refresh().catch(() => {})
    return true
  }

  const task = /^\/api\/v1\/tasks\/([^/]+)\/(hand-over|review|snooze|close|end-schedule|pause-schedule|resume-schedule|run-now|remove-time|reopen|follow-up)$/.exec(pathname)
  if (task && method === 'POST') {
    const body = await readJson(req)
    const base = { opId: str(body.opId) ?? randomUUID(), spaceId: str(body.spaceId) ?? '' }
    let input: CommandInput
    {
      const taskId = decodeURIComponent(task![1])
      const verb = task![2]
      if (verb === 'hand-over') {
        const mode = str(body.mode) as HandOverMode | undefined
        const delegate = str(body.delegate)
        if (!mode || !HAND_OVER_MODES.includes(mode) || !delegate) { refuse(json, res, 'invalid', 'mode (now · schedule · together) and delegate are required'); return true }
        // One time (at) becomes the task's wake-up, a repeat rule (cron) one of its repeating times (domain/hand-over.ts).
        const spec = readScheduleSpec(body.schedule, deps.now?.() ?? Date.now(), JOB_LIMITS)
        if (spec && 'error' in spec) { refuse(json, res, 'invalid', `schedule: ${spec.error}`); return true }
        input = { ...base, kind: 'hand_over', taskId, handOver: { mode, delegate, checkpoint: str(body.checkpoint), schedule: spec, desk: str(body.desk), ...(body.fresh === true ? { fresh: true } : {}) } }
      } else if (verb === 'review' || verb === 'close') {
        input = { ...base, kind: verb, taskId }
      } else if (verb === 'end-schedule') {
        input = { ...base, kind: 'end_schedule', taskId }
      } else if (verb === 'pause-schedule' || verb === 'resume-schedule' || verb === 'run-now') {
        input = { ...base, kind: verb === 'pause-schedule' ? 'pause_schedule' : verb === 'resume-schedule' ? 'resume_schedule' : 'run_now', taskId }
      } else if (verb === 'remove-time') {
        const cron = str(body.cron)
        if (!cron) { refuse(json, res, 'invalid', 'cron is required: the repeating time to remove'); return true }
        input = { ...base, kind: 'remove_time', taskId, cron }
      } else if (verb === 'reopen') {
        const reason = str(body.reason)?.trim().slice(0, 500)
        const message = typeof body.message === 'string' ? body.message : undefined
        input = { ...base, kind: 'reopen', taskId, ...(reason ? { reason } : {}), ...(message !== undefined ? { message } : {}) }
      } else if (verb === 'follow-up') {
        input = { ...base, kind: 'follow_up', taskId, ...(typeof body.message === 'string' ? { message: body.message } : {}) }
      } else {
        const key = str(body.key), until = str(body.until)
        if (!key || !until) { refuse(json, res, 'invalid', 'key and until are required'); return true }
        input = { ...base, kind: 'snooze', taskId, snooze: { key, until } }
      }
    }
    answer(json, res, await deps.commands.submit(input))
    void deps.board.refresh().catch(() => {})
    return true
  }
  return false
}
