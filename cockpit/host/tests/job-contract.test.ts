import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as http from 'node:http'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { JobStore } from '../src/job-store.js'
import { ensureJobTokens, handleJobContract, jobSpaceIdsOf } from '../src/job-contract-api.js'
import { JobRunner, type RunnerTask } from '../src/application/job-runner.js'
import { newRecord, type Job } from '../src/domain/job.js'
import { withSchedule } from '../src/domain/task-schedule.js'

// The channel bridge reaches the cockpit through /v1 with one space's token:
// it learns which records listen on a channel and wakes one; the cockpit decides
// which session of the task that reaches. The examples are the ones the bridge tests too.

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'job-contract.v1.json'), 'utf8'))
const SPACE = fixture.space as string
const OTHER = '99999999-2222-4333-8444-555555555555'
const JOB_ID = fixture.routes.response[0].jobId as string

const MATCH = [{ kind: 'domain', domain: 'Customer.example' }, { kind: 'address', address: 'support@partner.example' }, { kind: 'regex', pattern: '.*' }]
/** A task's record that listens on mail (domain/job.ts): its id, the contract's jobId, is the task's. */
const record = (id: string, patch: Partial<Job> = {}): Job => ({ ...newRecord({ id, spaceId: null }, '2026-11-08T00:00:00.000Z'), triggers: [{ type: 'mail', match: MATCH }], ...patch })

describe('job contract v1', () => {
  let store: JobStore
  let file: string
  let dir: string
  let server: http.Server
  let base: string
  let started: string[]
  let delivered: string[]
  let room: boolean
  let working: string[]
  let runner: JobRunner
  /** The task of the fixture's first record, as the brain has it. */
  let task: RunnerTask | null
  const token = (space: string) => readFileSync(join(dir, space), 'utf8')

  beforeEach(async () => {
    const home = mkdtempSync(join(tmpdir(), 'job-contract-'))
    dir = join(home, 'job-tokens')
    file = join(home, 'jobs.json')
    store = new JobStore(file)
    started = []
    delivered = []
    working = []
    room = true
    task = { id: JOB_ID, title: 'customer-mail', content: 'Answer customer mail as drafts.', status: 'active', scope: 'project.customer', properties: { assignee_ids: ['member'], display_title: 'Customer mail' } }
    ensureJobTokens([SPACE, OTHER], dir)
    runner = new JobRunner({
      // every pass reads the tasks: no minute to wait
      store, me: 'member', deriveEveryMs: 0, spaces: () => [{ key: null, name: 'Main', shared: false }],
      openTasks: async () => (task && ['planned', 'active'].includes(task.status) ? [task] : []), task: async (_space, id) => (task && id === task.id ? task : null),
      sessionsOf: () => working.map((sessionId) => ({ sessionId, working: true, linked: !sessionId.startsWith('own-') })), editSchedule: async () => {},
      hasRoom: () => room, sessionState: (id) => (started.includes(id) ? 'idle' : 'queued'), sessionRuns: (id) => working.includes(id),
      statusSince: () => null, deliver: async (sessionId) => { delivered.push(sessionId); return 'delivered' }, notify: () => {}, flag: () => {}, log: () => {}, timeZone: () => 'UTC',
      startWorker: (_record, _task, sessionId) => { started.push(sessionId); return null },
    })
    const json = (res: http.ServerResponse, status: number, payload: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)) }
    const readJson = (req: http.IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => resolve(body ? JSON.parse(body) : {}))
    })
    server = http.createServer((req, res) => {
      void handleJobContract(req, res, { store, spaceIds: () => [SPACE, OTHER], wake: (j, c, t, k) => runner.wake(j, c, t, k), held: (j) => runner.held(j), tokensDir: dir }, json, readJson)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(() => { server.close() })

  const call = async (path: string, space: string | null, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(space ? { Authorization: `Bearer ${token(space)}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, body: await res.json() }
  }

  it('makes one owner-only token per space and keeps it', () => {
    const before = token(SPACE)
    ensureJobTokens([SPACE], dir)
    expect(token(SPACE)).toBe(before)
    if (process.platform !== 'win32') expect(statSync(join(dir, SPACE)).mode & 0o777).toBe(0o600)
    expect(token(SPACE)).not.toBe(token(OTHER))
  })

  it('lists the space’s records that listen on mail as the fixture shows, held ones marked, drafting by default', async () => {
    store.put(record(JOB_ID))
    // waiting for the user's OK: listed as paused, so its mail still routes to it and waits
    store.put(record('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', { pendingApproval: true }))
    store.put(record('cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', { spaceId: OTHER }))
    // a record without a channel is no route
    store.put(record('dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee', { triggers: [] }))
    const answer = await call(`/v1/jobs?space=${SPACE}&channel=mail`, SPACE)
    expect(answer).toEqual({ status: 200, body: fixture.routes.response })
    // paused by the cockpit after failures: held too
    store.put(record(JOB_ID, { pausedReason: '3 failed runs in a row' }))
    expect((await call(`/v1/jobs?space=${SPACE}&channel=mail`, SPACE)).body[0]).toMatchObject({ jobId: JOB_ID, paused: true })
  })

  it('marks the route of a task whose schedule is paused, once the engine has read the task', async () => {
    store.put(record(JOB_ID))
    task = { ...task!, properties: { ...task!.properties, delegation: withSchedule({ agent: 'atlas' }, { crons: ['0 8 * * *'], paused: true }) } }
    await runner.tick()
    expect((await call(`/v1/jobs?space=${SPACE}&channel=mail`, SPACE)).body).toEqual([{ ...fixture.routes.response[0], paused: true }])
    task = { ...task!, properties: { ...task!.properties, delegation: withSchedule({ agent: 'atlas' }, { crons: ['0 8 * * *'] }) } }
    runner.resumed(JOB_ID)
    expect((await call(`/v1/jobs?space=${SPACE}&channel=mail`, SPACE)).body).toEqual([fixture.routes.response[0]])
  })

  it('lists no route for a task that is closed: its record stops listening with the next pass', async () => {
    store.put(record(JOB_ID))
    await runner.tick()
    expect((await call(`/v1/jobs?space=${SPACE}&channel=mail`, SPACE)).body).toHaveLength(1)
    task = { ...task!, status: 'resolved' }
    // before the pass has seen it: still listed, but a wake is refused
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.refused)
    await runner.tick()
    expect((await call(`/v1/jobs?space=${SPACE}&channel=mail`, SPACE)).body).toEqual([])
    expect(store.get(JOB_ID)).toBeUndefined()
  })

  it('refuses without a token, and with another space’s', async () => {
    expect((await call(`/v1/jobs?space=${SPACE}&channel=mail`, null)).status).toBe(401)
    expect((await call(`/v1/jobs?space=${SPACE}&channel=mail`, OTHER)).status).toBe(403)
    store.put(record(JOB_ID))
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, OTHER, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.refused)
    expect(started).toEqual([])
  })

  it('wakes the task once per key with a new session, and asks for a retry without room', async () => {
    store.put(record(JOB_ID))
    room = false
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.retry)
    expect(store.runs(JOB_ID)).toHaveLength(0)
    room = true
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.delivered)
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.delivered)
    expect(started).toHaveLength(1)
    expect(store.runs(JOB_ID)).toMatchObject([{ trigger: 'mail', number: 1, idempotencyKey: 'mail:thread-1:msg-2', message: '2 new mails from customer.example' }])
  })

  it('never skips a message: a session of the task that is working gets it, and no second session starts', async () => {
    store.put(record(JOB_ID))
    working = ['s-work']
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.delivered)
    expect(delivered).toEqual(['s-work'])
    expect(started).toEqual([])
  })

  it('starts a session for the message while the only working session of the task is one that has no bridge tools (not started for the record)', async () => {
    store.put(record(JOB_ID))
    working = ['own-session']
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.delivered)
    expect(delivered).toEqual([])
    expect(started).toHaveLength(1)
  })

  it('answers retry, never refused, to a wake under an id that is moving: a version 1 job that waits for its task, then the old id until the bridge has confirmed the new one', async () => {
    const OLD = 'aaaaaaaa-1111-4222-8333-444444444444'
    const wakeOld = async (space = SPACE) => (await call(`/v1/jobs/${OLD}/wake`, space, fixture.wake.request.body)).body
    // a version 1 file: the job has not moved onto its task yet
    writeFileSync(file, JSON.stringify({ version: 1, timeZone: 'UTC', jobs: { [OLD]: { id: OLD, name: 'Customer mail', spaceId: null, taskId: JOB_ID, triggers: [{ type: 'mail', match: MATCH }] } }, runs: {}, keys: {} }))
    store = new JobStore(file)
    expect(await wakeOld()).toEqual(fixture.wake.responses.retry)
    // another space's token learns nothing of it
    expect(await wakeOld(OTHER)).toEqual(fixture.wake.responses.refused)
    // it moved: the record has the task's id, and the bridge still asks under the old one
    store.migrateV1({ jobIds: [OLD], record: record(JOB_ID), renames: { [OLD]: JOB_ID } })
    expect(store.pendingV1()).toBeNull()
    expect(await wakeOld()).toEqual(fixture.wake.responses.retry)
    expect(await wakeOld(OTHER)).toEqual(fixture.wake.responses.refused)
    // the bridge has the new id: the old one names nothing any more
    store.renameConfirmed(OLD)
    expect(await wakeOld()).toEqual(fixture.wake.responses.refused)
    expect([started, delivered]).toEqual([[], []])
  })

  it('asks the events of a held record and of a paused schedule to come back later, and refuses those of a closed or unknown task', async () => {
    store.put(record(JOB_ID, { pendingApproval: true }))
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.retry)
    store.put(record(JOB_ID))
    const open = task!
    task = { ...open, properties: { ...open.properties, delegation: withSchedule({ agent: 'atlas' }, { crons: ['0 8 * * *'], paused: true }) } }
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.retry)
    task = { ...open, status: 'resolved' }
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.refused)
    expect((await call('/v1/jobs/eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee/wake', SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.refused)
    expect(started).toEqual([])
  })
})

describe('jobSpaceIdsOf', () => {
  it('gives the bridge the main space first and the other local ones, never a shared space or one not yet asked about', () => {
    const spaces = [
      { id: 'local-b', main: false, shared: false },
      { id: 'team', main: false, shared: true },
      { id: 'unknown', main: false, shared: null },
      { id: 'main-id', main: true, shared: null },
    ]
    expect(jobSpaceIdsOf(spaces)).toEqual(['main-id', 'local-b'])
  })
})
