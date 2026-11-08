import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from '../src/job-store.js'
import { JobRunner, type JobRunnerDeps, type RunSessionState } from '../src/application/job-runner.js'
import { Jobs, type JobCaller } from '../src/application/jobs.js'
import type { DeliveryOutcome } from '../src/domain/session-delivery.js'
import type { WorkerStatus } from '../src/domain/session-attention.js'
import type { Job } from '../src/domain/job.js'

// The runner wakes sessions for due jobs: a fresh worker per run, or a message
// to a session that exists. It starts only with room, retries a busy target,
// never runs a schedule twice for one time, and records what came of each run.

const MIN = 60_000
const HOUR = 60 * MIN

class World {
  now = Date.parse('2026-11-09T00:00:00Z') // Monday 08:00 in UTC+8
  room = true
  states = new Map<string, RunSessionState>()
  statuses = new Map<string, WorkerStatus>()
  started: Array<{ job: Job; sessionId: string; text: string }> = []
  delivered: Array<{ sessionId: string; text: string }> = []
  deliveryOutcome: DeliveryOutcome = 'resumed'
  alerts: string[] = []
  granted: string[] = []
  ended: string[] = []
  store = new JobStore(join(mkdtempSync(join(tmpdir(), 'jobs-')), 'jobs.json'))

  deps(): JobRunnerDeps {
    return {
      store: this.store,
      now: () => this.now,
      hasRoom: () => this.room,
      sessionState: (id) => this.states.get(id) ?? 'queued',
      sessionRuns: (id) => ['working', 'idle'].includes(this.states.get(id) ?? ''),
      statusSince: (id) => { const kind = this.statuses.get(id); return kind ? { kind, reason: kind === 'review' ? 'Brief written' : null } : null },
      deliver: async (sessionId, text) => {
        this.delivered.push({ sessionId, text })
        return this.deliveryOutcome
      },
      startWorker: (job, sessionId, text) => {
        this.started.push({ job, sessionId, text })
        return null
      },
      notify: (input) => { this.alerts.push(`${input.kind}: ${input.title}: ${input.body}`) },
      log: () => {},
      timeZone: () => 'Asia/Makassar',
      onGrantEnd: (job, tools) => { this.ended.push(`${job.name}:${tools.join(',')}`) },
    }
  }
}

const caller: JobCaller = { sessionId: 'maker', spaceId: null, projectId: 'bp-eml', toolProfile: null }

function setup() {
  const world = new World()
  const runner = new JobRunner(world.deps())
  const jobs = new Jobs({
    store: world.store, runner, now: () => world.now,
    resolveProject: async (_space, input) => (input === 'eml' ? 'bp-eml' : null),
    findSession: (_space, target) => (target === 'eml-other' ? 'other' : null),
    addressOf: (id) => `eml-${id}`,
    projectName: (_space, id) => (id === 'bp-eml' ? 'EML' : id),
    providerKnown: (id) => id === 'claude',
    defaultTimeZone: () => 'Asia/Makassar',
    onGrant: (job, tool) => { world.granted.push(`${job.name}:${tool}`) },
    onGrantEnd: (job, tools) => { world.ended.push(`${job.name}:${tools.join(',')}`) },
  })
  return { world, runner, jobs }
}

describe('job runner', () => {
  let world: World
  let runner: JobRunner
  let jobs: Jobs

  beforeEach(() => {
    ({ world, runner, jobs } = setup())
  })

  const create = async (input: Record<string, unknown>) => {
    const answer = await jobs.handle(caller, { action: 'create', name: 'Daily brief', prompt: 'Write the daily brief.', ...input })
    expect(answer.status, answer.text).toBe(201)
    return answer.job!
  }

  it('starts a worker with the job’s prompt when a schedule is due, and not again for the same time', async () => {
    const job = await create({ cron: '0 8 * * 1-5' })
    expect(job.nextRunAt).toBe('2026-11-10T00:00:00.000Z') // created exactly at 08:00: next is tomorrow
    world.now = Date.parse('2026-11-10T00:00:30Z')
    await runner.tick()
    await runner.tick()
    expect(world.started).toHaveLength(1)
    expect(world.started[0].text).toMatch(/^\[Scheduled by the cockpit: job "Daily brief" .*run 1, due Tue 10 Nov 08:00 Asia\/Makassar\. Not from your user/)
    expect(world.started[0].text).toMatch(/Write the daily brief\.$/)
    const stored = world.store.get(job.id)!
    expect(stored.nextRunAt).toBe('2026-11-11T00:00:00.000Z')
    expect(world.store.runs(job.id)[0]).toMatchObject({ status: 'started', number: 1, sessionId: world.started[0].sessionId })
  })

  it('waits for room and tries again later, then fails after an hour', async () => {
    const job = await create({ at: '2026-11-09T09:00' })
    world.room = false
    world.now = Date.parse('2026-11-09T01:00:00Z')
    await runner.tick()
    let run = world.store.runs(job.id)[0]
    expect(run).toMatchObject({ status: 'waiting', attempts: 1 })
    expect(Date.parse(run.nextAttemptAt!)).toBe(world.now + MIN)
    world.now += 61 * MIN
    await runner.tick()
    run = world.store.runs(job.id)[0]
    expect(run.status).toBe('failed')
    expect(run.note).toMatch(/could not start within 1 h/)
    expect(world.alerts[0]).toMatch(/^failed: Daily brief: Run 1 failed: could not start within 1 h/)
  })

  it('records the session’s status as the run’s outcome', async () => {
    const job = await create({ cron: '0 9 * * *' })
    world.now = Date.parse('2026-11-09T01:00:10Z')
    await runner.tick()
    const sessionId = world.started[0].sessionId
    world.states.set(sessionId, 'working')
    world.now += 5 * MIN
    await runner.tick()
    expect(world.store.runs(job.id)[0].status).toBe('started')
    world.statuses.set(sessionId, 'review')
    world.states.set(sessionId, 'idle')
    await runner.tick()
    expect(world.store.runs(job.id)[0]).toMatchObject({ status: 'finished', outcome: 'review' })
    expect(world.alerts).toEqual(['review: Daily brief: Run 1: Brief written'])
  })

  it('skips a run while the previous one still works', async () => {
    const job = await create({ cron: '0 9 * * *' })
    world.now = Date.parse('2026-11-09T01:00:10Z')
    await runner.tick()
    world.states.set(world.started[0].sessionId, 'working')
    world.now = Date.parse('2026-11-10T01:00:10Z')
    await runner.tick()
    expect(world.started).toHaveLength(1)
    expect(world.store.runs(job.id).map((r) => r.status)).toEqual(['started', 'skipped'])
  })

  it('misses a repeating run due more than 6 h ago, but runs a late one-time job', async () => {
    const daily = await create({ cron: '0 9 * * *' })
    const once = await create({ name: 'Check reply', at: '2026-11-09T10:00' })
    world.now = Date.parse('2026-11-09T09:00:00Z') // 17:00 local: 8 h late
    await runner.tick()
    expect(world.store.runs(daily.id).map((r) => r.status)).toEqual(['missed'])
    expect(world.alerts).toEqual([expect.stringMatching(/^missed: Daily brief: Missed a run due 8 h ago/)])
    expect(world.store.get(daily.id)!.nextRunAt).toBe('2026-11-10T01:00:00.000Z')
    expect(world.store.runs(once.id).map((r) => r.status)).toEqual(['started'])
    expect(world.started[0].text).toMatch(/420 min late/)
  })

  it('ends a one-time job once its run is over, quietly when it is done', async () => {
    const job = await create({ at: '2026-11-09T09:00' })
    world.now = Date.parse('2026-11-09T01:00:10Z')
    await runner.tick()
    const sessionId = world.started[0].sessionId
    world.statuses.set(sessionId, 'done')
    world.states.set(sessionId, 'stopped')
    await runner.tick()
    expect(world.store.get(job.id)!.endedAt).not.toBeNull()
    expect(world.alerts).toEqual([])
  })

  it('wakes its own session again on later runs', async () => {
    const job = await create({ cron: '0 9 * * *', target: 'job-session' })
    world.now = Date.parse('2026-11-09T01:00:10Z')
    await runner.tick()
    const sessionId = world.started[0].sessionId
    expect(world.store.get(job.id)!.target).toMatchObject({ type: 'job-session', sessionId })
    world.statuses.set(sessionId, 'done')
    world.states.set(sessionId, 'stopped')
    await runner.tick()
    world.statuses.delete(sessionId)
    world.now = Date.parse('2026-11-10T01:00:10Z')
    await runner.tick()
    expect(world.started).toHaveLength(1)
    expect(world.delivered).toEqual([{ sessionId, text: expect.stringMatching(/run 2,/) }])
  })

  it('messages the session itself, and retries while it is busy', async () => {
    const job = await create({ at: '2026-11-09T09:00', target: 'self' })
    world.states.set('maker', 'idle')
    world.deliveryOutcome = 'busy'
    world.now = Date.parse('2026-11-09T01:00:10Z')
    await runner.tick()
    expect(world.store.runs(job.id)[0]).toMatchObject({ status: 'waiting', attempts: 1 })
    world.deliveryOutcome = 'delivered'
    world.now += 2 * MIN
    await runner.tick()
    expect(world.delivered.map((d) => d.sessionId)).toEqual(['maker', 'maker'])
    expect(world.store.runs(job.id)[0].status).toBe('started')
  })

  it('pauses a job after three failures in a row and says so', async () => {
    const job = await create({ cron: '0 * * * *', target: 'self' })
    world.states.set('maker', 'idle')
    world.deliveryOutcome = 'unknown'
    for (let hour = 1; hour <= 3; hour++) {
      world.now = Date.parse('2026-11-09T00:00:10Z') + hour * HOUR
      await runner.tick()
    }
    const stored = world.store.get(job.id)!
    expect(stored.paused).toBe(true)
    expect(stored.pausedReason).toMatch(/3 failed runs in a row/)
    expect(world.alerts.at(-1)).toMatch(/^paused: Daily brief: Paused itself after 3 failed runs/)
    world.now += HOUR
    await runner.tick()
    expect(world.store.runs(job.id)).toHaveLength(3)
  })

  it('starts at most two runs per pass', async () => {
    for (const name of ['a', 'b', 'c']) await create({ name, at: '2026-11-09T09:00' })
    world.now = Date.parse('2026-11-09T01:00:10Z')
    await runner.tick()
    expect(world.started).toHaveLength(2)
    await runner.tick()
    expect(world.started).toHaveLength(3)
  })

  it('retries a run a restart cut off while starting, once', async () => {
    const job = await create({ at: '2026-11-09T09:00', target: 'self' })
    world.now = Date.parse('2026-11-09T01:00:10Z')
    const run = { ...(await (async () => { await runner.tick(); return world.store.runs(job.id)[0] })()) }
    world.store.updateRun({ ...run, status: 'starting', attempts: 1 })
    const after = new JobRunner(world.deps())
    after.recover()
    expect(world.store.runs(job.id)[0]).toMatchObject({ status: 'waiting', note: 'retried after a cockpit restart' })
  })
})

describe('schedule tool', () => {
  it('refuses schedules it cannot keep', async () => {
    const { jobs } = setup()
    const create = (input: Record<string, unknown>) => jobs.handle(caller, { action: 'create', name: 'x', prompt: 'p', ...input })
    expect((await create({})).text).toMatch(/exactly one of cron/)
    expect((await create({ cron: '0 8 * * *', at: '2026-11-10T08:00' })).text).toMatch(/exactly one of cron/)
    expect((await create({ cron: '*/5 * * * *' })).text).toMatch(/at most every 15 min/)
    expect((await create({ at: '2026-11-08T08:00' })).text).toMatch(/has passed/)
    expect((await create({ at: '2028-01-01T08:00' })).text).toMatch(/a year ahead/)
    expect((await create({ cron: '0 8 * * *', timezone: 'Mars/Olympus' })).text).toMatch(/unknown time zone/)
    expect((await create({ cron: '0 8 * * *', project: 'nope' })).text).toMatch(/unknown project/)
  })

  it('answers with the next runs in words', async () => {
    const { jobs } = setup()
    const answer = await jobs.handle(caller, { action: 'create', name: 'Daily brief', prompt: 'p', cron: '0 8 * * 1-5' })
    expect(answer.text).toMatch(/next: Tue 10 Nov 08:00, Wed 11 Nov 08:00, Thu 12 Nov 08:00/)
    expect(answer.text).toMatch(/a new worker per run in EML/)
  })

  it('keeps jobs in their space', async () => {
    const { jobs } = setup()
    await jobs.handle(caller, { action: 'create', name: 'Main job', prompt: 'p', cron: '0 8 * * *' })
    const other: JobCaller = { sessionId: 'sachi', spaceId: 'space-b', projectId: 'bp-x', toolProfile: null }
    expect((await jobs.handle(other, { action: 'list' })).text).toBe('No jobs in this space.')
    expect((await jobs.handle(other, { action: 'delete', job: 'Main job' })).status).toBe(404)
    expect((await jobs.handle(caller, { action: 'list' })).text).toMatch(/Main job/)
  })

  it('gives a job at most its maker’s tools', async () => {
    const { jobs } = setup()
    const limited: JobCaller = { ...caller, toolProfile: { deniedTools: ['Bash'], mcpServers: ['gmail'] } }
    const answer = await jobs.handle(limited, { action: 'create', name: 'x', prompt: 'p', cron: '0 8 * * *', deny_tools: ['WebFetch'] })
    expect(answer.job!.toolProfile).toEqual({ deniedTools: ['Bash', 'WebFetch'], mcpServers: ['gmail'] })
  })

  it('pauses, resumes from now, and refuses a second run while one is open', async () => {
    const { world, jobs } = setup()
    await jobs.handle(caller, { action: 'create', name: 'Daily', prompt: 'p', cron: '0 8 * * *' })
    expect((await jobs.handle(caller, { action: 'pause', job: 'daily' })).job!.paused).toBe(true)
    world.now += 3 * 24 * HOUR
    const resumed = await jobs.handle(caller, { action: 'resume', job: 'Daily' })
    expect(resumed.job!.nextRunAt).toBe('2026-11-13T00:00:00.000Z')
    world.room = false
    expect((await jobs.handle(caller, { action: 'run_now', job: 'Daily' })).status).toBe(202)
    expect((await jobs.handle(caller, { action: 'run_now', job: 'Daily' })).status).toBe(409)
  })
})

describe('mail jobs', () => {
  const createMail = async (jobs: Jobs, mail: unknown, extra: Record<string, unknown> = {}) =>
    jobs.handle(caller, { action: 'create', name: 'Acme mail', prompt: 'Draft replies to Acme.', mail, ...extra })

  it('listens on mail in one session of its own, drafts, and waits for the user’s OK', async () => {
    const { jobs } = setup()
    const answer = await createMail(jobs, { domains: ['Acme.example'], addresses: ['boss@partner.example'] })
    expect(answer.status, answer.text).toBe(201)
    expect(answer.job).toMatchObject({
      kind: 'standing', pendingApproval: true, reply: { mail: 'draft' }, nextRunAt: null,
      target: { type: 'job-session', projectId: 'bp-eml', sessionId: null },
      triggers: [{ type: 'mail', match: [{ kind: 'address', address: 'boss@partner.example' }, { kind: 'domain', domain: 'acme.example' }] }],
    })
    expect(answer.text).toMatch(/only after the user's OK in the Jobs view/)
    expect((await createMail(jobs, { domains: ['@acme.example'] }, { name: 'x' })).text).toMatch(/not a mail address or domain: @acme.example/)
  })

  it('holds wakes and run_now until approved; a session cannot approve or resume past it', async () => {
    const { world, runner, jobs } = setup()
    const job = (await createMail(jobs, { domains: ['acme.example'] })).job!
    expect(await runner.wake(world.store.get(job.id)!, 'mail', '1 new mail', 'k1')).toBe('retry')
    expect((await jobs.handle(caller, { action: 'run_now', job: job.id })).text).toMatch(/waits for the user's OK/)
    await jobs.handle(caller, { action: 'resume', job: job.id })
    expect(world.store.get(job.id)!.pendingApproval).toBe(true)
    jobs.approve(world.store.get(job.id)!)
    expect(await runner.wake(world.store.get(job.id)!, 'mail', '1 new mail', 'k1')).toBe('delivered')
    expect(world.started[0].text).toMatch(/woken by mail[\s\S]*Draft replies to Acme\.[\s\S]*1 new mail$/)
  })

  it('asks for the OK again when addresses grow, not when they shrink', async () => {
    const { world, jobs } = setup()
    const job = (await createMail(jobs, { domains: ['acme.example', 'acme.test'] })).job!
    jobs.approve(world.store.get(job.id)!)
    await jobs.handle(caller, { action: 'update', job: job.id, mail: { domains: ['acme.example'] } })
    expect(world.store.get(job.id)!.pendingApproval).toBe(false)
    const grown = await jobs.handle(caller, { action: 'update', job: job.id, mail: { domains: ['acme.example', 'other.example'] } })
    expect(grown.job!.pendingApproval).toBe(true)
  })

  it('lets only the page switch a channel to send', async () => {
    const { world, jobs } = setup()
    const job = (await createMail(jobs, { domains: ['acme.example'] })).job!
    expect(jobs.setReply(world.store.get(job.id)!, 'mail', 'send').job!.reply).toEqual({ mail: 'send' })
    expect(jobs.setReply(world.store.get(job.id)!, 'slack', 'send').status).toBe(400)
    expect((await jobs.handle(caller, { action: 'update', job: job.id, reply: { mail: 'draft' } })).job!.reply).toEqual({ mail: 'send' })
  })
})

describe('limited jobs and grants', () => {
  it('limits a mail job from the start; a schedule-only job is not', async () => {
    const { jobs } = setup()
    const mail = await jobs.handle(caller, { action: 'create', name: 'Acme mail', prompt: 'p', mail: { domains: ['acme.example'] } })
    expect(mail.job!.limited).toBe(true)
    const routine = await jobs.handle(caller, { action: 'create', name: 'Brief', prompt: 'p', cron: '0 8 * * *' })
    expect(routine.job!.limited).toBeUndefined()
    expect((await jobs.handle(caller, { action: 'update', job: mail.job!.id, limited: false, grants: [{ tool: 'chrome', until: '2099-01-01T00:00:00Z' }] })).job)
      .toMatchObject({ limited: true })
    expect(jobs.setLimited(mail.job!, false).job!.limited).toBe(false)
  })

  it('lends a tool for a while, tells the host, and takes it back when the session is done', async () => {
    const { world, runner, jobs } = setup()
    const job = (await jobs.handle(caller, { action: 'create', name: 'Returns', prompt: 'p', mail: { domains: ['shop.example'] } })).job!
    jobs.approve(world.store.get(job.id)!)
    expect(jobs.grant(world.store.get(job.id)!, 'chrome', 2, null).status).toBe(400)
    const lent = jobs.grant(world.store.get(job.id)!, 'chrome', 60, 'submit the return form')
    expect(lent.job!.grants).toEqual([{ tool: 'chrome', until: new Date(world.now + HOUR).toISOString(), reason: 'submit the return form' }])
    expect(world.granted).toEqual(['Returns:chrome'])
    expect((await jobs.handle(caller, { action: 'list' })).text).toMatch(/lent for now: chrome/)

    expect(await runner.wake(world.store.get(job.id)!, 'mail', '1 new mail', 'k')).toBe('delivered')
    const sessionId = world.started[0].sessionId
    world.statuses.set(sessionId, 'done')
    world.states.set(sessionId, 'idle')
    world.now += 2 * MIN
    await runner.tick()
    expect(world.store.get(job.id)!.grants).toEqual([])
    expect(world.ended).toEqual(['Returns:chrome'])
  })

  it('drops a grant once its time is up, and revoke takes it back at once', async () => {
    const { world, runner, jobs } = setup()
    const job = (await jobs.handle(caller, { action: 'create', name: 'Returns', prompt: 'p', mail: { domains: ['shop.example'] } })).job!
    jobs.grant(world.store.get(job.id)!, 'SendMessage', 30, null)
    jobs.grant(world.store.get(job.id)!, 'chrome', 90, null)
    expect(jobs.revoke(world.store.get(job.id)!, 'chrome').job!.grants!.map((g) => g.tool)).toEqual(['SendMessage'])
    world.now += 31 * MIN
    await runner.tick()
    expect(world.store.get(job.id)!.grants).toEqual([])
    expect(world.ended).toEqual(['Returns:chrome', 'Returns:SendMessage'])
  })
})
