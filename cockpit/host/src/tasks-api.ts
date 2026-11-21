import type * as http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { TaskBoard } from './application/task-board.js'
import type { CommandInput, CommandRefusal, Submitted, TaskCommands } from './application/task-commands.js'
import { HAND_OVER_MODES, type HandOverMode, type ScheduleSpec } from './domain/hand-over.js'

/**
 * The task board over HTTP, versioned (decision cockpit-host-routes-versioned-from-now). Page only:
 * the same-origin guard holds the writes.
 *   GET  /api/v1/tasks/board                        the board (application/task-board.ts)
 *   POST /api/v1/tasks/<id>/hand-over               { opId, spaceId, mode, delegate, checkpoint, schedule?, desk? }
 *   POST /api/v1/tasks/<id>/review                  { opId, spaceId }: Looks good, done
 *   POST /api/v1/tasks/<id>/snooze                  { opId, spaceId, key, until }
 *   POST /api/v1/tasks/<id>/close                   { opId, spaceId }: drop a task that is not needed
 *   POST /api/v1/commands/<opId>/undo
 * A command answers 202 { opId, state, undoUntil, carriedQuestion?, brief?, effects? }; Work on it now
 * happens at once, and the page opens the session in its desk with the brief. A refusal answers
 * { error: { code, message, retry } }: the code is what the page branches on, retry whether trying
 * again can help.
 */

export interface TasksApiDeps {
  board: TaskBoard
  commands: TaskCommands
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
  space_has_no_runner: 'The task system is off in this space, so nothing would start the agent.',
  schedule_required: 'Pick when the agent starts.',
  desk_required: 'Pick the desk to open the session in.',
  bound_items: 'Decisions or notes are bound to this task: close it in the chat, which asks which of them stay.',
  open_steps: 'This task still has open steps: close or move them first.',
  unknown_command: 'No such action to undo.',
  undo_expired: 'Too late to undo: the action already happened.',
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

  const undo = /^\/api\/v1\/commands\/([^/]+)\/undo$/.exec(pathname)
  if (undo && method === 'POST') {
    const result = await deps.commands.undo(decodeURIComponent(undo[1]))
    if (!result.ok) refuse(json, res, result.refusal)
    else json(res, 200, { state: 'undone' })
    void deps.board.refresh().catch(() => {})
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
