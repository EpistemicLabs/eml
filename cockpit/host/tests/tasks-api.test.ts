import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleTasksApi, type TasksApiDeps } from '../src/tasks-api.js'
import type { CommandInput } from '../src/application/task-commands.js'

const submitted: CommandInput[] = []
let refreshed = 0
const deps = {
  now: () => Date.parse('2026-11-19T10:00:00Z'),
  board: {
    get: async () => ({ at: 'now', counts: { needsYou: 1, inbox: 0 } }),
    refresh: async () => { refreshed++; return {} },
    closed: async (spaceId: string, project: string, limit: number) => {
      if (spaceId === 'main') return { ok: true, page: { tasks: [{ id: 'old', spaceId, project, limit }], more: true } }
      if (spaceId === 'offline') return { ok: false, refusal: 'brain_unavailable' }
      if (spaceId === 'unbound') return { ok: false, refusal: 'no_brain' }
      return { ok: false, refusal: 'unknown_space' }
    },
  },
  commands: {
    submit: async (input: CommandInput) => {
      submitted.push(input)
      if (input.taskId === 'closed') return { ok: false, refusal: 'task_closed' }
      if (input.taskId === 'daily' && input.kind === 'close') return { ok: false, refusal: 'scheduled' }
      if (input.taskId === 'plain' && input.kind === 'end_schedule') return { ok: false, refusal: 'not_scheduled' }
      if (input.taskId === 'theirs') return { ok: false, refusal: 'not_owner', message: 'Only its owner (dominik) can reopen this task.' }
      if (input.taskId === 'gone') return { ok: false, refusal: 'no_session' }
      if (input.taskId === 'placeholder') return { ok: false, refusal: 'not_ready' }
      if (input.kind === 'run_now' && RUN_NOW_REFUSALS.includes(input.taskId as never)) return { ok: false, refusal: input.taskId }
      return { ok: true, command: { ...input, state: input.handOver?.mode === 'together' ? 'applied' : 'pending', undoUntil: '2026-11-19T10:00:08.000Z', createdAt: '', ...(input.taskId === 'asked' ? { carriedQuestion: 'Which list?' } : {}), ...(input.taskId === 'solo' ? { tookOver: 's1' } : {}) } }
    },
    undo: async (opId: string) => (opId === 'late' ? { ok: false, refusal: 'undo_expired' } : { ok: true }),
  },
  split: {
    submit: async (input: Record<string, unknown>) => {
      splits.push(input)
      if (input.relation === 'sub') return { ok: false, refusal: 'sub_needs_task' }
      return { ok: true, command: { opId: input.opId, state: 'applied', undoUntil: '2026-11-22T10:05:00.000Z', split: { createdTaskId: 't-new', spawnedSessionId: 's-new' } } }
    },
    owns: (opId: string) => opId.startsWith('split-'),
    undo: async () => { splitUndone++; return { ok: true, command: {} } },
  },
  startOnTask: async (input: Record<string, unknown>) => {
    starts.push(input)
    return input.taskId === 'closed' ? { ok: false, refusal: 'task_closed' } : { ok: true, sessionId: 's-started' }
  },
  sort: {
    apply: async (input: { opId: string; sessionId: string; rows: unknown[] }) => {
      sorts.push(input)
      return input.sessionId === 'notask' ? { ok: false, refusal: 'no_task' } : { ok: true, command: { opId: input.opId, sort: { linked: 1, created: 2, closed: 0 } } }
    },
  },
  brief: {
    context: async (sessionId: string, title?: string) => (sessionId === 'nope' ? null : { projects: [{ id: 'p-ui', name: 'UI' }], hasTask: true, title: title ?? null }),
    write: async (sessionId: string, upTo?: string) => {
      if (sessionId === 'nope') return { ok: false, reason: 'unknown_session' }
      if (sessionId === 'broken') return { ok: false, reason: 'failed', message: 'not signed in', context: { projects: [], hasTask: false } }
      return { ok: true, draft: { title: 'Media viewer', relation: 'spun', projectId: 'p-ui', brief: `Goal: files (${upTo ?? 'end'}).` }, context: { projects: [{ id: 'p-ui', name: 'UI' }], hasTask: true } }
    },
  },
  migration: {
    dryRun: async (spaceId: string) => (spaceId === 'main' ? { ok: true, report: '# dry run', plan: { changes: [] }, at: 'now' } : { ok: false, refusal: 'unknown_space' }),
    run: async (spaceId: string) => spaceId === 'busy' ? { ok: false, refusal: 'in_flight', message: 'running' }
      : spaceId === 'partly' ? { ok: true, written: 2, failed: ['t1: down'], tasksMade: 0, report: '' }
        : { ok: true, written: 3, failed: [], tasksMade: 0, report: '' },
  },
} as unknown as TasksApiDeps
/** Run now on a task of that name is refused with it. */
const RUN_NOW_REFUSALS = ['run_open', 'task_working', 'needs_approval', 'no_project', 'not_scheduled'] as const
const splits: Array<Record<string, unknown>> = []
const sorts: Array<Record<string, unknown>> = []
const starts: Array<Record<string, unknown>> = []
let splitUndone = 0

let server: http.Server
let base: string
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const json = (r: http.ServerResponse, status: number, payload: unknown) => { r.writeHead(status, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(payload)) }
    const readJson = async (r: http.IncomingMessage) => { const chunks: Buffer[] = []; for await (const c of r) chunks.push(c as Buffer); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} }
    const url = new URL(req.url!, 'http://x')
    if (!(await handleTasksApi(req, res, deps, url.pathname, req.method!, json, readJson))) json(res, 404, { error: 'none' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}

describe('task board routes', () => {
  it('serves the migration: GET is the dry run, POST the run; a partial failure says a retry helps', async () => {
    const dry = await fetch(`${base}/api/v1/tasks/migration?spaceId=main`)
    expect([dry.status, (await dry.json()).report]).toEqual([200, '# dry run'])
    expect((await fetch(`${base}/api/v1/tasks/migration`)).status).toBe(400)
    expect((await fetch(`${base}/api/v1/tasks/migration?spaceId=nowhere`)).status).toBe(404)
    expect(await post('/api/v1/tasks/migration', { spaceId: 'main' })).toMatchObject({ status: 200, body: { ok: true, written: 3 } })
    expect(await post('/api/v1/tasks/migration', { spaceId: 'partly' })).toMatchObject({ status: 502, body: { error: { code: 'migration_failed', retry: true }, failed: ['t1: down'] } })
    expect(await post('/api/v1/tasks/migration', { spaceId: 'busy' })).toMatchObject({ status: 409, body: { error: { code: 'in_flight', retry: true } } })
    expect((await post('/api/v1/tasks/migration', {})).status).toBe(400)
  })

  it('serves the board', async () => {
    const r = await fetch(`${base}/api/v1/tasks/board`)
    expect(await r.json()).toEqual({ at: 'now', counts: { needsYou: 1, inbox: 0 } })
  })

  it('serves a project\'s closed tasks, up to the limit the page asks for', async () => {
    const get = async (query: string) => { const r = await fetch(`${base}/api/v1/tasks/closed?${query}`); return { status: r.status, body: await r.json() } }
    expect(await get('spaceId=main&project=acme&limit=40')).toEqual({ status: 200, body: { tasks: [{ id: 'old', spaceId: 'main', project: 'acme', limit: 40 }], more: true } })
    expect((await get('spaceId=nowhere&project=acme&limit=20')).status).toBe(404)
    expect((await get('spaceId=main&project=acme')).status).toBe(400)
    expect(await get('spaceId=unbound&project=acme&limit=20')).toMatchObject({ status: 503, body: { error: { code: 'no_brain', retry: true } } })
    expect(await get('spaceId=offline&project=acme&limit=20')).toMatchObject({ status: 502, body: { error: { code: 'brain_unavailable', retry: true } } })
    expect((await get('spaceId=main&limit=20')).status).toBe(400)
    expect((await get('spaceId=main&project=acme&limit=0')).status).toBe(400)
  })

  it('hands a task over and answers with the undo deadline and a carried question', async () => {
    const r = await post('/api/v1/tasks/asked/hand-over', { opId: 'op-1', spaceId: 'main', mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' } })
    expect(r).toEqual({ status: 202, body: { opId: 'op-1', state: 'pending', undoUntil: '2026-11-19T10:00:08.000Z', carriedQuestion: 'Which list?' } })
    // one time is read in its zone and handed on as an instant
    expect(submitted.at(-1)).toEqual({ opId: 'op-1', spaceId: 'main', kind: 'hand_over', taskId: 'asked', handOver: { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T01:00:00.000Z', timeZone: 'Asia/Singapore' }, desk: undefined } })
    expect(refreshed).toBeGreaterThan(0)
  })

  it('carries Start fresh, answers a Take over with the session it took over, and names why a hand-over cannot happen', async () => {
    await post('/api/v1/tasks/t1/hand-over', { opId: 'op-fresh', spaceId: 'main', mode: 'now', delegate: 'atlas', checkpoint: 'after', fresh: true })
    expect(submitted.at(-1)!.handOver).toMatchObject({ mode: 'now', fresh: true })
    // only true counts
    await post('/api/v1/tasks/t1/hand-over', { opId: 'op-keep', spaceId: 'main', mode: 'now', delegate: 'atlas', checkpoint: 'after', fresh: 'yes' })
    expect(submitted.at(-1)!.handOver).not.toHaveProperty('fresh')
    expect(await post('/api/v1/tasks/solo/hand-over', { opId: 'op-take', spaceId: 'main', mode: 'together', delegate: 'atlas' }))
      .toEqual({ status: 202, body: { opId: 'op-take', state: 'applied', undoUntil: '2026-11-19T10:00:08.000Z', sessionId: 's1' } })
    expect((await post('/api/v1/tasks/gone/hand-over', { opId: 'op-gone', spaceId: 'main', mode: 'together', delegate: 'atlas' })).body.error)
      .toMatchObject({ code: 'no_session', message: 'The task has no open session to take over: pick a desk to start one.' })
    expect((await post('/api/v1/tasks/placeholder/hand-over', { opId: 'op-ph', spaceId: 'main', mode: 'now', delegate: 'atlas', checkpoint: 'after' })).body.error)
      .toMatchObject({ code: 'not_ready' })
  })

  it('carries a hand-over\'s schedule: one time or a repeat rule; the session choice and until the goal of before are gone; says what is wrong with one', async () => {
    await post('/api/v1/tasks/asked/hand-over', { opId: 'op-goal', spaceId: 'main', mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'UTC', session: 'resume', untilGoal: true } })
    expect(submitted.at(-1)!.handOver!.schedule).toEqual({ at: '2026-11-20T09:00:00.000Z', timeZone: 'UTC' })
    await post('/api/v1/tasks/asked/hand-over', { opId: 'op-routine', spaceId: 'main', mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { cron: '0 9 * * 1-5', timeZone: 'UTC', session: 'new' } })
    expect(submitted.at(-1)!.handOver!.schedule).toEqual({ cron: '0 9 * * 1-5', timeZone: 'UTC' })
    expect(await post('/api/v1/tasks/asked/hand-over', { opId: 'op-bad', spaceId: 'main', mode: 'schedule', delegate: 'atlas', schedule: { at: '2026-11-19T09:00', timeZone: 'UTC' } }))
      .toMatchObject({ status: 400, body: { error: { code: 'invalid', message: expect.stringMatching(/^schedule: at: .* has passed$/) } } })
    expect((await post('/api/v1/tasks/asked/hand-over', { opId: 'op-bad1', spaceId: 'main', mode: 'schedule', delegate: 'atlas', schedule: { cron: '* * * * *', timeZone: 'UTC' } })).body.error.message)
      .toBe('schedule: that cron fires every 1 min; at most every 15 min')
  })

  it('takes End schedule and close under a kebab-case route like its siblings, and refuses Close on a task whose schedule is on with a code to branch on', async () => {
    expect(await post('/api/v1/tasks/daily/end-schedule', { opId: 'op-es', spaceId: 'main' }))
      .toEqual({ status: 202, body: { opId: 'op-es', state: 'pending', undoUntil: '2026-11-19T10:00:08.000Z' } })
    expect(submitted.at(-1)).toEqual({ opId: 'op-es', spaceId: 'main', kind: 'end_schedule', taskId: 'daily' })
    expect(await post('/api/v1/tasks/daily/close', { opId: 'op-c', spaceId: 'main' }))
      .toEqual({ status: 409, body: { error: { code: 'scheduled', message: 'Its schedule is still on: use End schedule and close.', retry: false } } })
    expect(await post('/api/v1/tasks/plain/end-schedule', { opId: 'op-p', spaceId: 'main' }))
      .toEqual({ status: 409, body: { error: { code: 'not_scheduled', message: 'It has no schedule to end: close it instead.', retry: false } } })
  })

  it('takes Run now, and answers each of its refusals with its status', async () => {
    expect((await post('/api/v1/tasks/daily/run-now', { opId: 'op-rn', spaceId: 'main' })).status).toBe(202)
    expect(submitted.at(-1)).toEqual({ opId: 'op-rn', spaceId: 'main', kind: 'run_now', taskId: 'daily' })
    const refused = async (code: string) => { const r = await post(`/api/v1/tasks/${code}/run-now`, { spaceId: 'main' }); return [r.status, r.body.error.code] }
    expect(await refused('needs_approval')).toEqual([409, 'needs_approval'])
    expect(await refused('not_scheduled')).toEqual([409, 'not_scheduled'])
    // no session could start for it: not a conflict that passes, the task has to be moved into a project
    expect(await post('/api/v1/tasks/no_project/run-now', { spaceId: 'main' }))
      .toEqual({ status: 422, body: { error: { code: 'no_project', message: 'The task has no project to run in: move it into a project first.', retry: false } } })
  })

  it('takes review, snooze and close; refuses with a code to branch on', async () => {
    expect((await post('/api/v1/tasks/t1/review', { opId: 'op-2', spaceId: 'main' })).status).toBe(202)
    expect((await post('/api/v1/tasks/t1/snooze', { opId: 'op-3', spaceId: 'main', key: 'task:t1@s', until: '2026-11-20T01:00:00Z' })).status).toBe(202)
    expect((await post('/api/v1/tasks/t1/close', { opId: 'op-4', spaceId: 'main' })).status).toBe(202)
    expect(submitted.slice(-3).map((s) => [s.kind, s.taskId])).toEqual([['review', 't1'], ['snooze', 't1'], ['close', 't1']])

    expect(await post('/api/v1/tasks/closed/review', { opId: 'op-5', spaceId: 'main' }))
      .toEqual({ status: 409, body: { error: { code: 'task_closed', message: 'The task is closed.', retry: false } } })
    expect((await post('/api/v1/tasks/t1/hand-over', { spaceId: 'main', mode: 'later', delegate: 'atlas' })).body.error.code).toBe('invalid')
    expect((await post('/api/v1/tasks/t1/snooze', { spaceId: 'main' })).body.error.code).toBe('invalid')
  })

  it('takes a reopen with an optional reason; another owner\'s task is refused with 403', async () => {
    expect((await post('/api/v1/tasks/t9/reopen', { opId: 'op-r', spaceId: 'main', reason: '  found a bug  ' })).status).toBe(202)
    expect(submitted.at(-1)).toEqual({ opId: 'op-r', spaceId: 'main', kind: 'reopen', taskId: 't9', reason: 'found a bug' })
    expect((await post('/api/v1/tasks/t9/reopen', { opId: 'op-r2', spaceId: 'main' })).status).toBe(202)
    expect(submitted.at(-1)).toEqual({ opId: 'op-r2', spaceId: 'main', kind: 'reopen', taskId: 't9' })
    expect(await post('/api/v1/tasks/theirs/reopen', { opId: 'op-r3', spaceId: 'main' }))
      .toEqual({ status: 403, body: { error: { code: 'not_owner', message: 'Only its owner (dominik) can reopen this task.', retry: false } } })
  })

  it('takes a reopen with a message from the task\'s chat, and a follow-up with its brief', async () => {
    expect((await post('/api/v1/tasks/t9/reopen', { opId: 'op-m', spaceId: 'main', message: 'One more fix' })).status).toBe(202)
    expect(submitted.at(-1)).toEqual({ opId: 'op-m', spaceId: 'main', kind: 'reopen', taskId: 't9', message: 'One more fix' })
    expect((await post('/api/v1/tasks/t9/follow-up', { opId: 'op-f', spaceId: 'main', message: 'Now the phone layout' })).status).toBe(202)
    expect(submitted.at(-1)).toEqual({ opId: 'op-f', spaceId: 'main', kind: 'follow_up', taskId: 't9', message: 'Now the phone layout' })
    expect((await post('/api/v1/tasks/t9/follow-up', { opId: 'op-f2', spaceId: 'main' })).status).toBe(202)
    expect(submitted.at(-1)).toEqual({ opId: 'op-f2', spaceId: 'main', kind: 'follow_up', taskId: 't9' })
  })

  it('undoes, or says it is too late', async () => {
    expect(await post('/api/v1/commands/op-1/undo', {})).toEqual({ status: 200, body: { state: 'undone' } })
    expect((await post('/api/v1/commands/late/undo', {})).body.error.code).toBe('undo_expired')
  })

  it('splits a topic off a session and undoes it through the one undo route', async () => {
    const r = await post('/api/v1/sessions/s1/split', { opId: 'split-1', title: 'Media viewer', brief: 'Goal: files.', relation: 'spun', when: 'now', projectId: 'p-ui' })
    expect(r).toEqual({ status: 202, body: { opId: 'split-1', state: 'applied', undoUntil: '2026-11-22T10:05:00.000Z', taskId: 't-new', sessionId: 's-new' } })
    expect(splits.at(-1)).toEqual({ opId: 'split-1', sessionId: 's1', title: 'Media viewer', brief: 'Goal: files.', relation: 'spun', when: 'now', projectId: 'p-ui' })
    expect((await post('/api/v1/commands/split-1/undo', {})).body).toEqual({ state: 'undone' })
    expect(splitUndone).toBe(1)
  })

  it('refuses a split with a missing field or a sub-task without a task', async () => {
    expect((await post('/api/v1/sessions/s1/split', { opId: 'x', title: 'T', relation: 'sideways', when: 'now', projectId: 'p' })).status).toBe(400)
    const sub = await post('/api/v1/sessions/s1/split', { opId: 'y', title: 'T', brief: 'b', relation: 'sub', when: 'now', projectId: 'p' })
    expect(sub).toMatchObject({ status: 409, body: { error: { code: 'sub_needs_task' } } })
  })

  it('drafts a split brief up to a picked message, and says why when it cannot', async () => {
    expect(await post('/api/v1/sessions/s1/split-brief', { upTo: 'u2' })).toEqual({ status: 200, body: { title: 'Media viewer', relation: 'spun', projectId: 'p-ui', brief: 'Goal: files (u2).', context: { projects: [{ id: 'p-ui', name: 'UI' }], hasTask: true } } })
    expect((await post('/api/v1/sessions/nope/split-brief', {})).status).toBe(404)
    expect(await post('/api/v1/sessions/s1/split-brief', { contextOnly: true, title: 'Media viewer' })).toEqual({ status: 200, body: { context: { projects: [{ id: 'p-ui', name: 'UI' }], hasTask: true, title: 'Media viewer' } } })
    expect(await post('/api/v1/sessions/broken/split-brief', {})).toMatchObject({ status: 502, body: { error: { code: 'brief_failed', retry: true }, context: { hasTask: false } } })
  })

  it('applies a sort of a drifted session, and refuses rows it cannot read', async () => {
    const r = await post('/api/v1/sessions/s1/sort', { opId: 'sort-1', rows: [{ topic: 'Media viewer', pick: 'spun', brief: 'Goal.' }, { topic: 'Board', pick: 'sub', taskId: 't-b' }] })
    expect(r).toEqual({ status: 200, body: { opId: 'sort-1', linked: 1, created: 2, closed: 0 } })
    expect(sorts.at(-1)).toEqual({ opId: 'sort-1', sessionId: 's1', rows: [{ topic: 'Media viewer', pick: 'spun', brief: 'Goal.' }, { topic: 'Board', pick: 'sub', taskId: 't-b' }] })
    expect((await post('/api/v1/sessions/s1/sort', { rows: [{ topic: 'X', pick: 'park' }] })).status).toBe(400)
    expect((await post('/api/v1/sessions/notask/sort', { opId: 'sort-2', rows: [] })).status).toBe(409)
    expect((await post('/api/v1/sessions/s1/sort', { rows: [] })).status).toBe(400)
  })

  it('starts a session of the user\'s own on a task, opened by the page where it says', async () => {
    const r = await post('/api/v1/tasks/t1/start', { spaceId: 'main', deskId: 'desk-2', prompt: 'Run the task', projectId: 'bp-ui' })
    expect(r).toEqual({ status: 202, body: { sessionId: 's-started' } })
    expect(starts.at(-1)).toEqual({ spaceId: 'main', taskId: 't1', deskId: 'desk-2', prompt: 'Run the task', projectId: 'bp-ui' })
    expect((await post('/api/v1/tasks/closed/start', { spaceId: 'main' })).status).toBe(409)
    expect((await post('/api/v1/tasks/t1/start', {})).status).toBe(400)
  })
})
