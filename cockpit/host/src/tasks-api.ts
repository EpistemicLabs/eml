import type * as http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { TaskBoard } from './application/task-board.js'
import type { CommandInput, CommandRefusal, Submitted, TaskCommands } from './application/task-commands.js'
import type { SplitBrief } from './application/split-brief.js'
import type { SplitAnswer, SplitSession } from './application/split-session.js'
import type { SortSession } from './application/sort-session.js'
import { SORT_PICKS, type SortPick, type SortRow } from './domain/sort.js'
import { HAND_OVER_MODES, type HandOverMode, type ScheduleSpec } from './domain/hand-over.js'
import { SPLIT_RELATIONS, SPLIT_WHENS, type SplitRelation, type SplitWhen } from './domain/split.js'

/**
 * The task board over HTTP, versioned (decision cockpit-host-routes-versioned-from-now). Page only:
 * the same-origin guard holds the writes.
 *   GET  /api/v1/tasks/board                        the board (application/task-board.ts)
 *   GET  /api/v1/tasks/closed?spaceId&project&limit  a project's newest closed tasks, done and dropped: { tasks, more }
 *   POST /api/v1/tasks/<id>/hand-over               { opId, spaceId, mode, delegate, checkpoint, schedule?, desk? }
 *   POST /api/v1/tasks/<id>/review                  { opId, spaceId }: Looks good, done
 *   POST /api/v1/tasks/<id>/snooze                  { opId, spaceId, key, until }
 *   POST /api/v1/tasks/<id>/close                   { opId, spaceId }: drop a task that is not needed
 *   POST /api/v1/sessions/<id>/split                { opId, title, brief, relation, when, projectId, existingTaskId? }: split a topic off a session (onto an open task, with existingTaskId)
 *   POST /api/v1/sessions/<id>/split-brief          { upTo?, contextOnly? }: a draft (title, relation, projectId, brief) from the turns up to a message; contextOnly: only the dialog's context, no model call
 *   POST /api/v1/sessions/<id>/sort                 { opId, rows: [{ topic, pick, taskId?, brief? }] }: sort a drifted session
 *   POST /api/v1/tasks/<id>/start                   { spaceId, projectId?, prompt?, title?, deskId? }: a session of the user's own on the task (chat when that is their view)
 *   POST /api/v1/commands/<opId>/undo
 * A command answers 202 { opId, state, undoUntil, carriedQuestion?, brief?, effects? }; Work on it now
 * happens at once, and the page opens the session in its desk with the brief. A refusal answers
 * { error: { code, message, retry } }: the code is what the page branches on, retry whether trying
 * again can help.
 */

export interface TasksApiDeps {
  board: TaskBoard
  commands: TaskCommands
  split: SplitSession
  brief: SplitBrief
  sort: SortSession
  /** Start a session of the user's own on a task: the host binds the task, the page opens the pane (in chat when that is the user's view). */
  startOnTask(input: { spaceId: string; taskId: string; projectId?: string; prompt?: string; title?: string; deskId?: string }): Promise<
    { ok: true; sessionId: string } | { ok: false; refusal: 'unknown_space' | 'unknown_task' | 'task_closed' | 'no_project'; message?: string }
  >
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
  schedule_required: 'Pick when the agent starts.',
  desk_required: 'Pick the desk to open the session in.',
  bound_items: 'Decisions or notes are bound to this task: close it in the chat, which asks which of them stay.',
  open_steps: 'This task still has open steps: close or move them first.',
  unknown_command: 'No such action to undo.',
  undo_expired: 'Too late to undo: the action already happened.',
}

type SplitRefusalCode = Extract<SplitAnswer, { ok: false }>['refusal']

const SPLIT_MESSAGES: Record<SplitRefusalCode, string> = {
  invalid: 'The split needs an opId, a title, a brief, how it relates (spun · sub · unrelated) and when (now · park).',
  sub_needs_task: 'A sub-task needs a task to hang under, and this session has none.',
  unknown_session: 'No such session.',
  unknown_project: 'No such project in this session\'s space.',
  unknown_task: 'That task is not open (or not in this space).',
  no_brain: 'The space has no brain to write to right now.',
  unknown_command: 'No such action to undo.',
  undo_expired: 'Too late to undo the split.',
  in_flight: 'This split is still running.',
}

const SPLIT_STATUS: Partial<Record<SplitRefusalCode, number>> = {
  unknown_session: 404, unknown_project: 404, unknown_task: 404, unknown_command: 404, sub_needs_task: 409, undo_expired: 409, in_flight: 409, no_brain: 503,
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
  no_brain: 503,
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
  })
}

function schedule(body: Record<string, unknown>): ScheduleSpec | undefined {
  const s = body.schedule as Record<string, unknown> | undefined
  const timeZone = str(s?.timeZone)
  if (!s || !timeZone) return undefined
  const at = str(s.at), cron = str(s.cron)
  if (at && !cron) return { at, timeZone }
  if (cron && !at) return { cron, timeZone }
  return undefined
}

export async function handleTasksApi(
  req: http.IncomingMessage, res: http.ServerResponse, deps: TasksApiDeps, pathname: string, method: string, json: Json, readJson: ReadJson,
): Promise<boolean> {
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

  const task = /^\/api\/v1\/tasks\/([^/]+)\/(hand-over|review|snooze|close)$/.exec(pathname)
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
        input = { ...base, kind: 'hand_over', taskId, handOver: { mode, delegate, checkpoint: str(body.checkpoint), schedule: schedule(body), desk: str(body.desk) } }
      } else if (verb === 'review' || verb === 'close') {
        input = { ...base, kind: verb, taskId }
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
