import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleTasksApi, type TasksApiDeps } from '../src/tasks-api.js'
import type { CommandInput } from '../src/application/task-commands.js'

const submitted: CommandInput[] = []
let refreshed = 0
const deps = {
  board: {
    get: async () => ({ at: 'now', counts: { needsYou: 1, inbox: 0 } }),
    refresh: async () => { refreshed++; return {} },
  },
  commands: {
    submit: async (input: CommandInput) => {
      submitted.push(input)
      if (input.taskId === 'closed') return { ok: false, refusal: 'task_closed' }
      return { ok: true, command: { ...input, state: 'pending', undoUntil: '2026-11-19T10:00:08.000Z', createdAt: '', ...(input.taskId === 'asked' ? { carriedQuestion: 'Which list?' } : {}) } }
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
  sort: {
    apply: async (input: { opId: string; sessionId: string; rows: unknown[] }) => {
      sorts.push(input)
      return input.sessionId === 'notask' ? { ok: false, refusal: 'no_task' } : { ok: true, command: { opId: input.opId, sort: { linked: 1, created: 2, closed: 0 } } }
    },
  },
  brief: {
    context: async (sessionId: string) => (sessionId === 'nope' ? null : { projects: [{ id: 'p-ui', name: 'UI' }], taskSystem: true, hasTask: true }),
    write: async (sessionId: string, upTo?: string) => {
      if (sessionId === 'nope') return { ok: false, reason: 'unknown_session' }
      if (sessionId === 'broken') return { ok: false, reason: 'failed', message: 'not signed in', context: { projects: [], taskSystem: false, hasTask: false } }
      return { ok: true, draft: { title: 'Media viewer', relation: 'spun', projectId: 'p-ui', brief: `Goal: files (${upTo ?? 'end'}).` }, context: { projects: [{ id: 'p-ui', name: 'UI' }], taskSystem: true, hasTask: true } }
    },
  },
} as unknown as TasksApiDeps
const splits: Array<Record<string, unknown>> = []
const sorts: Array<Record<string, unknown>> = []
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
  it('serves the board', async () => {
    const r = await fetch(`${base}/api/v1/tasks/board`)
    expect(await r.json()).toEqual({ at: 'now', counts: { needsYou: 1, inbox: 0 } })
  })

  it('hands a task over and answers with the undo deadline and a carried question', async () => {
    const r = await post('/api/v1/tasks/asked/hand-over', { opId: 'op-1', spaceId: 'main', mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' } })
    expect(r).toEqual({ status: 202, body: { opId: 'op-1', state: 'pending', undoUntil: '2026-11-19T10:00:08.000Z', carriedQuestion: 'Which list?' } })
    expect(submitted.at(-1)).toEqual({ opId: 'op-1', spaceId: 'main', kind: 'hand_over', taskId: 'asked', handOver: { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' }, desk: undefined } })
    expect(refreshed).toBeGreaterThan(0)
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
    expect(await post('/api/v1/sessions/s1/split-brief', { upTo: 'u2' })).toEqual({ status: 200, body: { title: 'Media viewer', relation: 'spun', projectId: 'p-ui', brief: 'Goal: files (u2).', context: { projects: [{ id: 'p-ui', name: 'UI' }], taskSystem: true, hasTask: true } } })
    expect((await post('/api/v1/sessions/nope/split-brief', {})).status).toBe(404)
    expect(await post('/api/v1/sessions/s1/split-brief', { contextOnly: true })).toEqual({ status: 200, body: { context: { projects: [{ id: 'p-ui', name: 'UI' }], taskSystem: true, hasTask: true } } })
    expect(await post('/api/v1/sessions/broken/split-brief', {})).toMatchObject({ status: 502, body: { error: { code: 'brief_failed', retry: true }, context: { taskSystem: false } } })
  })

  it('applies a sort of a drifted session, and refuses rows it cannot read', async () => {
    const r = await post('/api/v1/sessions/s1/sort', { opId: 'sort-1', rows: [{ topic: 'Media viewer', pick: 'spun', brief: 'Goal.' }, { topic: 'Board', pick: 'sub', taskId: 't-b' }] })
    expect(r).toEqual({ status: 200, body: { opId: 'sort-1', linked: 1, created: 2, closed: 0 } })
    expect(sorts.at(-1)).toEqual({ opId: 'sort-1', sessionId: 's1', rows: [{ topic: 'Media viewer', pick: 'spun', brief: 'Goal.' }, { topic: 'Board', pick: 'sub', taskId: 't-b' }] })
    expect((await post('/api/v1/sessions/s1/sort', { rows: [{ topic: 'X', pick: 'park' }] })).status).toBe(400)
    expect((await post('/api/v1/sessions/notask/sort', { opId: 'sort-2', rows: [] })).status).toBe(409)
    expect((await post('/api/v1/sessions/s1/sort', { rows: [] })).status).toBe(400)
  })
})
