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
} as unknown as TasksApiDeps

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
    const r = await post('/api/v1/tasks/asked/hand-over', { opId: 'op-1', spaceId: 'main', mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Makassar' } })
    expect(r).toEqual({ status: 202, body: { opId: 'op-1', state: 'pending', undoUntil: '2026-11-19T10:00:08.000Z', carriedQuestion: 'Which list?' } })
    expect(submitted.at(-1)).toEqual({ opId: 'op-1', spaceId: 'main', kind: 'hand_over', taskId: 'asked', handOver: { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Makassar' }, desk: undefined } })
    expect(refreshed).toBeGreaterThan(0)
  })

  it('takes review, snooze and triage; refuses with a code to branch on', async () => {
    expect((await post('/api/v1/tasks/t1/review', { opId: 'op-2', spaceId: 'main' })).status).toBe(202)
    expect((await post('/api/v1/tasks/t1/snooze', { opId: 'op-3', spaceId: 'main', key: 'task:t1@s', until: '2026-11-20T01:00:00Z' })).status).toBe(202)
    expect((await post('/api/v1/triage/pending-1', { opId: 'op-4', spaceId: 'main', action: 'merge', intoTaskId: 't1' })).status).toBe(202)
    expect(submitted.slice(-3).map((s) => s.kind)).toEqual(['review', 'snooze', 'triage'])

    expect(await post('/api/v1/tasks/closed/review', { opId: 'op-5', spaceId: 'main' }))
      .toEqual({ status: 409, body: { error: { code: 'task_closed', message: 'The task is closed.', retry: false } } })
    expect((await post('/api/v1/tasks/t1/hand-over', { spaceId: 'main', mode: 'later', delegate: 'atlas' })).body.error.code).toBe('invalid')
    expect((await post('/api/v1/tasks/t1/snooze', { spaceId: 'main' })).body.error.code).toBe('invalid')
    expect((await post('/api/v1/triage/pending-1', { spaceId: 'main', action: 'keep' })).body.error.code).toBe('invalid')
  })

  it('undoes, or says it is too late', async () => {
    expect(await post('/api/v1/commands/op-1/undo', {})).toEqual({ status: 200, body: { state: 'undone' } })
    expect((await post('/api/v1/commands/late/undo', {})).body.error.code).toBe('undo_expired')
  })
})
