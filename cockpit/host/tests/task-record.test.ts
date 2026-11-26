import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { JobStore } from '../src/job-store.js'
import { createTaskRecords, type TaskRecords } from '../src/application/task-record.js'
import { handleTasksApi, type TasksApiDeps } from '../src/tasks-api.js'
import { newRecord, type Job, type JobRun } from '../src/domain/job.js'
import type { CommandInput } from '../src/application/task-commands.js'

// The user's per-machine settings of a scheduled task sit on the task's record: their OK for new channel addresses,
// send or draft, the Limited switch, lent tools. And the schedule's controls are task commands. Both are reached
// under the task, where the Jobs view's controls moved.

const NOW = Date.parse('2026-11-26T10:00:00.000Z')
const mail: Job['triggers'] = [{ type: 'mail', match: [{ kind: 'domain', domain: 'customer.example' }] }]
const run = (id: string, patch: Partial<JobRun> = {}): JobRun => ({
  id, jobId: 't1', trigger: 'schedule', number: 1, dueAt: '2026-11-26T08:00:00.000Z', createdAt: '2026-11-26T08:00:00.000Z', status: 'finished', attempts: 1,
  nextAttemptAt: null, sessionId: null, startedAt: null, finishedAt: null, outcome: null, note: null, ...patch,
})

let store: JobStore
let records: TaskRecords
let lent: string[]
let taken: string[]
let statuses: Record<string, string | Error>

beforeEach(() => {
  store = new JobStore(null)
  lent = []
  taken = []
  statuses = { t1: 'active', plain: 'active', closed: 'resolved', down: new Error('brain is down') }
  records = createTaskRecords({
    store, now: () => NOW,
    spaceKey: (spaceId) => (spaceId === 'main' ? null : spaceId === 'team' ? 'team-id' : undefined),
    taskStatus: async (_spaceId, taskId) => {
      const status = statuses[taskId] ?? null
      if (status instanceof Error) throw status
      return status
    },
    held: (record) => record.pendingApproval === true,
    sessionInfo: (sessionId) => (sessionId === 's1' ? { projectId: 'bp-eml', chat: true, attention: 'review' } : null),
    onGrant: (record, tool) => lent.push(`${record.id}:${tool}`),
    onGrantEnd: (record, tools) => taken.push(`${record.id}:${tools.join(',')}`),
  })
})

const put = (patch: Partial<Job> = {}) => store.put({ ...newRecord({ id: 't1', spaceId: null }, '2026-11-01T00:00:00.000Z'), ...patch })

describe('a task\'s record, for the page', () => {
  it('shows the record, its newest runs first with their sessions, and whether it is held or running', () => {
    put({ triggers: mail, pendingApproval: true })
    store.addRun(run('r1'))
    store.addRun(run('r2', { number: 2, status: 'started', sessionId: 's1' }))
    store.addRun(run('r3', { number: 0, status: 'skipped', sessionId: 'gone' }))
    const view = records.view('main', 't1')
    expect(view).toMatchObject({ record: { id: 't1', pendingApproval: true }, held: true, running: true })
    expect('runs' in view && view.runs.map((r) => [r.id, r.session])).toEqual([['r3', null], ['r2', { projectId: 'bp-eml', chat: true, attention: 'review' }], ['r1', null]])
  })

  it('shows at most twenty runs', () => {
    put()
    for (let i = 0; i < 25; i++) store.addRun(run(`r${i}`, { number: i + 1 }))
    const view = records.view('main', 't1')
    expect('runs' in view && view.runs).toHaveLength(20)
    expect('runs' in view && view.runs[0].id).toBe('r24')
  })

  it('answers a task this cockpit keeps nothing for with no record; another space\'s record is none either', () => {
    expect(records.view('main', 'plain')).toEqual({ record: null, runs: [], held: false, running: false })
    put()
    expect(records.view('team', 't1')).toEqual({ record: null, runs: [], held: false, running: false })
    expect(records.view('nowhere', 't1')).toMatchObject({ ok: false, refusal: 'unknown_space' })
  })
})

describe('the user\'s own decisions on a record', () => {
  it('approves new channel addresses once', () => {
    put({ triggers: mail, pendingApproval: true })
    expect(records.approve('main', 't1')).toMatchObject({ ok: true, text: 'Approved: its channel wakes the task from now.' })
    expect(store.get('t1')).not.toHaveProperty('pendingApproval')
    expect(store.get('t1')?.updatedAt).toBe('2026-11-26T10:00:00.000Z')
    expect(records.approve('main', 't1')).toMatchObject({ ok: true, text: 'It needs no OK.' })
  })

  it('switches a channel between draft and send, only one the task listens on', () => {
    put({ triggers: mail })
    expect(records.setReply('main', 't1', 'mail', 'send')).toMatchObject({ ok: true, text: 'It sends mail replies.', record: { reply: { mail: 'send' } } })
    expect(records.setReply('main', 't1', 'mail', 'draft')).toMatchObject({ ok: true, record: { reply: { mail: 'draft' } } })
    expect(records.setReply('main', 't1', 'slack', 'send')).toMatchObject({ ok: false, refusal: 'invalid', message: 'The task does not listen on slack.' })
  })

  it('limits a task, making its record when it has none; only an open task of the space', async () => {
    expect(await records.setLimited('main', 'plain', true)).toMatchObject({ ok: true, text: 'Its sessions are limited.', record: { id: 'plain', taskId: 'plain', spaceId: null, limited: true, cursor: null } })
    expect(store.get('plain')?.limited).toBe(true)
    // the same id in another space is not this record: it is never written over
    expect(await records.setLimited('team', 'plain', true)).toMatchObject({ ok: false, refusal: 'unknown_task' })
    expect(store.get('plain')?.spaceId).toBeNull()
    store.remove('plain')
    expect(await records.setLimited('team', 'plain', true)).toMatchObject({ ok: true, record: { spaceId: 'team-id' } })
    store.remove('plain')
    expect(await records.setLimited('main', 'closed', true)).toMatchObject({ ok: false, refusal: 'task_closed' })
    expect(await records.setLimited('main', 'nope', true)).toMatchObject({ ok: false, refusal: 'unknown_task' })
    expect(await records.setLimited('main', 'down', true)).toMatchObject({ ok: false, refusal: 'no_brain' })
    expect(await records.setLimited('nowhere', 'plain', true)).toMatchObject({ ok: false, refusal: 'unknown_space' })
    // free without a record: nothing to do, and no record is made for it
    expect(await records.setLimited('main', 'plain', false)).toEqual({ ok: true, text: 'It is not limited.', record: null })
    expect(store.list()).toEqual([])
  })

  it('frees a limited task again, and what was lent for the limit goes back', async () => {
    put({ limited: true, grants: [{ tool: 'chrome', until: '2026-11-26T11:00:00.000Z', reason: null }, { tool: 'SendMessage', until: '2026-11-26T09:00:00.000Z', reason: null }] })
    expect(await records.setLimited('main', 't1', false)).toMatchObject({ ok: true, text: 'Its sessions are no longer limited.', record: { limited: false, grants: [] } })
    expect(taken).toEqual(['t1:chrome'])
  })

  it('lends a tool for a while, replacing an earlier loan of it, and tells the host', () => {
    put({ limited: true, grants: [{ tool: 'chrome', until: '2026-11-26T10:30:00.000Z', reason: 'old' }, { tool: 'SendMessage', until: '2026-11-26T09:00:00.000Z', reason: null }] })
    expect(records.grant('main', 't1', 'chrome', 60, 'Check the shop')).toMatchObject({ ok: true, text: 'Its sessions may use chrome until 2026-11-26T11:00:00.000Z.' })
    // the loan that ran out is dropped with the write
    expect(store.get('t1')?.grants).toEqual([{ tool: 'chrome', until: '2026-11-26T11:00:00.000Z', reason: 'Check the shop' }])
    expect(lent).toEqual(['t1:chrome'])
    for (const minutes of [4, 24 * 60 + 1, Number.NaN]) expect(records.grant('main', 't1', 'chrome', minutes, null)).toMatchObject({ ok: false, refusal: 'invalid' })
  })

  it('takes a lent tool back at once; one that had run out goes without a word to the host', () => {
    put({ limited: true, grants: [{ tool: 'chrome', until: '2026-11-26T11:00:00.000Z', reason: null }, { tool: 'SendMessage', until: '2026-11-26T09:00:00.000Z', reason: null }] })
    expect(records.revoke('main', 't1', 'chrome')).toMatchObject({ ok: true, text: 'Its sessions no longer have chrome.' })
    expect(records.revoke('main', 't1', 'SendMessage')).toMatchObject({ ok: true })
    expect(store.get('t1')?.grants).toEqual([])
    expect(taken).toEqual(['t1:chrome'])
  })

  it('refuses every setting but the limit on a task without a record', () => {
    for (const answer of [records.approve('main', 'plain'), records.setReply('main', 'plain', 'mail', 'send'), records.grant('main', 'plain', 'chrome', 60, null), records.revoke('main', 'plain', 'chrome')]) {
      expect(answer).toMatchObject({ ok: false, refusal: 'no_record' })
    }
    expect(records.approve('nowhere', 't1')).toMatchObject({ ok: false, refusal: 'unknown_space' })
  })
})

describe('the routes under the task', () => {
  const submitted: CommandInput[] = []
  let refreshed = 0
  let server: http.Server
  let base: string
  const deps = (): TasksApiDeps => ({
    board: { refresh: async () => { refreshed++; return {} } },
    commands: {
      submit: async (input: CommandInput) => {
        submitted.push(input)
        if (input.taskId === 'busy') return { ok: false, refusal: 'task_working' }
        if (input.taskId === 'open-run') return { ok: false, refusal: 'run_open' }
        if (input.taskId === 'mail') return { ok: false, refusal: 'needs_approval' }
        if (input.taskId === 'plain') return { ok: false, refusal: 'not_scheduled', message: 'It has no schedule.' }
        if (input.kind === 'remove_time' && input.cron === '0 9 * * *') return { ok: false, refusal: 'unknown_time' }
        return { ok: true, command: { ...input, state: 'applied', undoUntil: '2026-11-26T10:00:00.000Z', createdAt: '2026-11-26T10:00:00.000Z' } }
      },
    },
    records,
  }) as unknown as TasksApiDeps

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const json = (r: http.ServerResponse, status: number, payload: unknown) => { r.writeHead(status, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(payload)) }
      const readJson = async (r: http.IncomingMessage) => { const chunks: Buffer[] = []; for await (const c of r) chunks.push(c as Buffer); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} }
      const url = new URL(req.url!, 'http://x')
      if (!(await handleTasksApi(req, res, deps(), url.pathname, req.method!, json, readJson))) json(res, 404, { error: 'none' })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())
  beforeEach(() => { submitted.length = 0; refreshed = 0 })

  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  const get = async (path: string) => { const r = await fetch(`${base}${path}`); return { status: r.status, body: await r.json() } }

  it('pause, resume and run now are task commands that are applied at once', async () => {
    expect(await post('/api/v1/tasks/daily/pause-schedule', { opId: 'op-1', spaceId: 'main' })).toEqual({ status: 202, body: { opId: 'op-1', state: 'applied', undoUntil: '2026-11-26T10:00:00.000Z' } })
    expect((await post('/api/v1/tasks/daily/resume-schedule', { opId: 'op-2', spaceId: 'main' })).status).toBe(202)
    expect((await post('/api/v1/tasks/daily/run-now', { opId: 'op-3', spaceId: 'main' })).status).toBe(202)
    expect(submitted).toEqual([
      { opId: 'op-1', spaceId: 'main', kind: 'pause_schedule', taskId: 'daily' },
      { opId: 'op-2', spaceId: 'main', kind: 'resume_schedule', taskId: 'daily' },
      { opId: 'op-3', spaceId: 'main', kind: 'run_now', taskId: 'daily' },
    ])
    expect(refreshed).toBe(3)
  })

  it('remove-time names the repeating time; without one it is refused before any command', async () => {
    expect((await post('/api/v1/tasks/daily/remove-time', { opId: 'op-1', spaceId: 'main', cron: '0 8 * * 1-5' })).status).toBe(202)
    expect(submitted).toEqual([{ opId: 'op-1', spaceId: 'main', kind: 'remove_time', taskId: 'daily', cron: '0 8 * * 1-5' }])
    expect(await post('/api/v1/tasks/daily/remove-time', { opId: 'op-2', spaceId: 'main' })).toMatchObject({ status: 400, body: { error: { code: 'invalid', message: 'cron is required: the repeating time to remove' } } })
    expect(await post('/api/v1/tasks/daily/remove-time', { opId: 'op-3', spaceId: 'main', cron: '0 9 * * *' })).toEqual({ status: 409, body: { error: { code: 'unknown_time', message: 'Its schedule has no such repeating time.', retry: false } } })
    expect(submitted).toHaveLength(2)
  })

  it('answers each refusal with its code, a sentence, and 409', async () => {
    expect(await post('/api/v1/tasks/busy/run-now', { spaceId: 'main' })).toEqual({ status: 409, body: { error: { code: 'task_working', message: 'A session of the task is working right now: nothing is started beside it.', retry: false } } })
    expect(await post('/api/v1/tasks/open-run/run-now', { spaceId: 'main' })).toEqual({ status: 409, body: { error: { code: 'run_open', message: 'Its last run is still going: wait for it to finish.', retry: false } } })
    expect(await post('/api/v1/tasks/mail/run-now', { spaceId: 'main' })).toEqual({ status: 409, body: { error: { code: 'needs_approval', message: 'Its channel waits for your OK first.', retry: false } } })
    expect(await post('/api/v1/tasks/plain/pause-schedule', { spaceId: 'main' })).toEqual({ status: 409, body: { error: { code: 'not_scheduled', message: 'It has no schedule.', retry: false } } })
  })

  it('GET record shows what this cockpit keeps for the task; it needs the space', async () => {
    put({ triggers: mail, pendingApproval: true })
    store.addRun(run('r1'))
    expect(await get('/api/v1/tasks/t1/record?spaceId=main')).toMatchObject({ status: 200, body: { record: { id: 't1', triggers: mail, pendingApproval: true }, runs: [{ id: 'r1', session: null }], held: true, running: false } })
    expect(await get('/api/v1/tasks/plain/record?spaceId=main')).toEqual({ status: 200, body: { record: null, runs: [], held: false, running: false } })
    expect((await get('/api/v1/tasks/t1/record')).status).toBe(400)
    expect(await get('/api/v1/tasks/t1/record?spaceId=nowhere')).toMatchObject({ status: 404, body: { error: { code: 'unknown_space' } } })
  })

  it('POST record/<setting> changes one setting and answers with the record', async () => {
    put({ triggers: mail, pendingApproval: true })
    expect(await post('/api/v1/tasks/t1/record/approve', { spaceId: 'main' })).toMatchObject({ status: 200, body: { text: 'Approved: its channel wakes the task from now.', record: { id: 't1' } } })
    expect(await post('/api/v1/tasks/t1/record/reply', { spaceId: 'main', channel: 'mail', mode: 'send' })).toMatchObject({ status: 200, body: { record: { reply: { mail: 'send' } } } })
    expect(await post('/api/v1/tasks/t1/record/limited', { spaceId: 'main', limited: true })).toMatchObject({ status: 200, body: { record: { limited: true } } })
    expect(await post('/api/v1/tasks/t1/record/grant', { spaceId: 'main', tool: 'chrome', reason: 'Look at the shop' })).toMatchObject({ status: 200, body: { record: { grants: [{ tool: 'chrome', until: '2026-11-26T11:00:00.000Z', reason: 'Look at the shop' }] } } })
    expect(await post('/api/v1/tasks/t1/record/revoke', { spaceId: 'main', tool: 'chrome' })).toMatchObject({ status: 200, body: { record: { grants: [] } } })
    expect(lent).toEqual(['t1:chrome'])
    expect(taken).toEqual(['t1:chrome'])
    expect(refreshed).toBe(5)
  })

  it('refuses a setting it cannot read, and one for a task without a record', async () => {
    put({ triggers: mail })
    const invalid = { status: 400, body: { error: { code: 'invalid', retry: false } } }
    expect(await post('/api/v1/tasks/t1/record/approve', {})).toMatchObject(invalid)
    expect(await post('/api/v1/tasks/t1/record/limited', { spaceId: 'main', limited: 'yes' })).toMatchObject(invalid)
    expect(await post('/api/v1/tasks/t1/record/grant', { spaceId: 'main', tool: 'Bash' })).toMatchObject(invalid)
    expect(await post('/api/v1/tasks/t1/record/grant', { spaceId: 'main', tool: 'chrome', minutes: 1 })).toMatchObject(invalid)
    expect(await post('/api/v1/tasks/t1/record/reply', { spaceId: 'main', channel: 'fax', mode: 'send' })).toMatchObject(invalid)
    expect(await post('/api/v1/tasks/t1/record/reply', { spaceId: 'main', channel: 'mail', mode: 'shout' })).toMatchObject(invalid)
    expect(await post('/api/v1/tasks/plain/record/approve', { spaceId: 'main' })).toMatchObject({ status: 404, body: { error: { code: 'no_record', message: 'This cockpit keeps no schedule settings for the task yet.' } } })
    expect(await post('/api/v1/tasks/closed/record/limited', { spaceId: 'main', limited: true })).toMatchObject({ status: 409, body: { error: { code: 'task_closed' } } })
    expect(await post('/api/v1/tasks/down/record/limited', { spaceId: 'main', limited: true })).toMatchObject({ status: 503, body: { error: { code: 'no_brain', retry: true } } })
    // no such setting, and no way to read a setting's route
    expect((await post('/api/v1/tasks/t1/record/delete', { spaceId: 'main' })).status).toBe(404)
    expect((await get('/api/v1/tasks/t1/record/approve?spaceId=main')).status).toBe(404)
    expect((await post('/api/v1/tasks/t1/record', { spaceId: 'main' })).status).toBe(404)
  })
})
