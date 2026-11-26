import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as http from 'node:http'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { JobStore } from '../src/job-store.js'
import { ensureJobTokens, handleJobContract, jobSpaceIdsOf } from '../src/job-contract-api.js'
import { JobRunner } from '../src/application/job-runner.js'
import { newRecord, type Job as TaskRecord } from '../src/domain/job.js'
import type { JobV1 as Job } from '../src/domain/job-v1.js'

// The channel bridge reaches the cockpit through /v1 with one space's token:
// it learns which jobs listen on a channel and wakes one; the cockpit decides
// which session that reaches. The examples are the ones the bridge tests too.

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'job-contract.v1.json'), 'utf8'))
const SPACE = fixture.space as string
const OTHER = '99999999-2222-4333-8444-555555555555'
const JOB_ID = fixture.routes.response[0].jobId as string

const job = (patch: Partial<Job> = {}): Job => ({
  id: JOB_ID, name: 'Customer mail', kind: 'standing', spaceId: null, createdBy: null,
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', taskId: null, prompt: 'Answer customer mail as drafts.',
  target: { type: 'job-session', projectId: 'bp-customer', sessionId: null },
  triggers: [{ type: 'mail', match: [{ kind: 'domain', domain: 'Customer.example' }, { kind: 'address', address: 'support@partner.example' }, { kind: 'regex', pattern: '.*' }] }],
  toolProfile: null, reply: {}, end: null, notify: 'needs-me', paused: false, pausedReason: null, endedAt: null, nextRunAt: null, runCount: 0, failures: 0,
  ...patch,
})

const MATCH = [{ kind: 'domain', domain: 'Customer.example' }, { kind: 'address', address: 'support@partner.example' }, { kind: 'regex', pattern: '.*' }]
/** A task's record that listens on mail (domain/job.ts): its id, the contract's jobId, is the task's. */
const record = (id: string, patch: Partial<TaskRecord> = {}): TaskRecord => ({ ...newRecord({ id, spaceId: null }, '2026-11-08T00:00:00.000Z'), triggers: [{ type: 'mail', match: MATCH }], ...patch })

describe('job contract v1', () => {
  // SEAM (part B2): the wake tests below still go through the version 1 runner with version 1 jobs; the routes are the records'.
  let store: JobStore<Job>
  let dir: string
  let server: http.Server
  let base: string
  let started: string[]
  let room: boolean
  let listed: JobStore | null
  const token = (space: string) => readFileSync(join(dir, space), 'utf8')

  beforeEach(async () => {
    const home = mkdtempSync(join(tmpdir(), 'job-contract-'))
    dir = join(home, 'job-tokens')
    store = new JobStore<Job>(join(home, 'jobs.json'))
    started = []
    room = true
    listed = null
    ensureJobTokens([SPACE, OTHER], dir)
    const runner = new JobRunner({
      store, hasRoom: () => room, sessionState: (id) => (started.includes(id) ? 'idle' : 'queued'), sessionRuns: () => false,
      statusSince: () => null, deliver: async () => 'delivered', notify: () => {}, flag: () => {}, log: () => {}, timeZone: () => 'UTC',
      startWorker: (_job, sessionId) => { started.push(sessionId); return null },
    })
    const json = (res: http.ServerResponse, status: number, payload: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)) }
    const readJson = (req: http.IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => resolve(body ? JSON.parse(body) : {}))
    })
    server = http.createServer((req, res) => {
      void handleJobContract(req, res, { store: listed ?? (store as unknown as JobStore), spaceIds: () => [SPACE, OTHER], wake: (j, c, t, k) => runner.wake(j as unknown as Job, c, t, k), tokensDir: dir }, json, readJson)
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
    const records = new JobStore(join(mkdtempSync(join(tmpdir(), 'job-contract-records-')), 'jobs.json'))
    records.put(record(JOB_ID))
    // waiting for the user's OK: listed as paused, so its mail still routes to it and waits
    records.put(record('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', { pendingApproval: true }))
    records.put(record('cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', { spaceId: OTHER }))
    // a record without a channel is no route
    records.put(record('dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee', { triggers: [] }))
    listed = records
    const answer = await call(`/v1/jobs?space=${SPACE}&channel=mail`, SPACE)
    expect(answer).toEqual({ status: 200, body: fixture.routes.response })
    // paused by the cockpit after failures: held too
    records.put(record(JOB_ID, { pausedReason: '3 failed runs in a row' }))
    expect((await call(`/v1/jobs?space=${SPACE}&channel=mail`, SPACE)).body[0]).toMatchObject({ jobId: JOB_ID, paused: true })
  })

  it('refuses without a token, and with another space’s', async () => {
    expect((await call(`/v1/jobs?space=${SPACE}&channel=mail`, null)).status).toBe(401)
    expect((await call(`/v1/jobs?space=${SPACE}&channel=mail`, OTHER)).status).toBe(403)
    store.put(job())
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, OTHER, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.refused)
  })

  it('wakes the job once per key, and asks for a retry without room', async () => {
    store.put(job())
    room = false
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.retry)
    expect(store.runs(JOB_ID)).toHaveLength(0)
    room = true
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.delivered)
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.delivered)
    expect(started).toHaveLength(1)
    expect(store.runs(JOB_ID)).toMatchObject([{ trigger: 'mail', number: 1, idempotencyKey: 'mail:thread-1:msg-2', message: '2 new mails from customer.example' }])
  })

  it('asks a paused job’s events to come back later and refuses an ended one', async () => {
    store.put(job({ paused: true }))
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.retry)
    store.put(job({ endedAt: '2026-11-08T01:00:00.000Z' }))
    expect((await call(`/v1/jobs/${JOB_ID}/wake`, SPACE, fixture.wake.request.body)).body).toEqual(fixture.wake.responses.refused)
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
