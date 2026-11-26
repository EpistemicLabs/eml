import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from '../src/job-store.js'
import { Jobs, type JobCaller } from '../src/application/jobs.js'
import type { JobV1 as Job } from '../src/domain/job-v1.js'

// SEAM (part B3 of "a task holds its schedule"): the schedule tool still is the version 1 one (application/jobs.ts),
// on jobs with their own schedule, and no session reaches it. These are its cases that need no engine: the engine
// that fired version 1 jobs is gone (tests/job-runner.test.ts covers the one that fires the tasks' schedules), so
// nothing here starts a run. Part B3 rebuilds the tool on the task's schedule and replaces this file.

class World {
  now = Date.parse('2026-11-09T00:00:00Z') // Monday 08:00 in UTC+8
  granted: string[] = []
  ended: string[] = []
  store = new JobStore<Job>(join(mkdtempSync(join(tmpdir(), 'jobs-')), 'jobs.json'))
}

const caller: JobCaller = { sessionId: 'maker', spaceId: null, projectId: 'bp-eml', toolProfile: null }

function setup(opts: { sharedSpaces?: string[] } = {}) {
  const world = new World()
  // What ran a version 1 job by hand: nothing does any more.
  const runner = { runNow: () => null, tick: async () => {} }
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
    sharedSpace: (spaceId) => !!spaceId && (opts.sharedSpaces ?? []).includes(spaceId),
  })
  return { world, jobs }
}

describe('version 1 jobs', () => {
  let world: World
  let jobs: Jobs

  beforeEach(() => {
    ({ world, jobs } = setup())
  })

  const create = async (input: Record<string, unknown>) => {
    const answer = await jobs.handle(caller, { action: 'create', name: 'Daily brief', prompt: 'Write the daily brief.', ...input })
    expect(answer.status, answer.text).toBe(201)
    return answer.job!
  }

  it('links a job to the task its maker works on, unless it names another; without one it has none', async () => {
    const onTask: JobCaller = { ...caller, taskId: 'task-1' }
    const own = await jobs.handle(onTask, { action: 'create', name: 'Check reply', prompt: 'p', at: '2026-11-20T10:00' })
    expect(own.job!.taskId).toBe('task-1')
    const named = await jobs.handle(onTask, { action: 'create', name: 'Other check', prompt: 'p', at: '2026-11-20T10:00', task_id: 'task-2' })
    expect(named.job!.taskId).toBe('task-2')
    expect((await create({ cron: '0 8 * * *' })).taskId).toBeNull()
  })

  it('moves a job-session job to a worker per run with update target=worker', async () => {
    const made = await create({ cron: '0 9 * * *' })
    world.store.put({ ...made, target: { type: 'job-session', projectId: 'bp-eml', sessionId: 'old-session' } })
    const moved = await jobs.handle(caller, { action: 'update', job: made.id, target: 'worker' })
    expect(moved.status, moved.text).toBe(200)
    expect(world.store.get(made.id)!.target).toEqual({ type: 'worker', projectId: 'bp-eml' })
    expect((await jobs.handle(caller, { action: 'update', job: made.id, target: 'self' })).text).toMatch(/only moves a job-session job to a worker/)
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
    expect((await create({ cron: '0 8 * * *', target: 'job-session' })).text)
      .toMatch(/^job-session is gone: a worker per run \(the default\) keeps its memory in the task's goal and journal; self wakes this session/)
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
    const other: JobCaller = { sessionId: 'other-caller', spaceId: 'space-b', projectId: 'bp-x', toolProfile: null }
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

})

describe('mail jobs', () => {
  const createMail = async (jobs: Jobs, mail: unknown, extra: Record<string, unknown> = {}) =>
    jobs.handle(caller, { action: 'create', name: 'Acme mail', prompt: 'Draft replies to Acme.', mail, ...extra })

  it('listens on mail with a fresh worker per mail, drafts, and waits for the user’s OK', async () => {
    const { jobs } = setup()
    const answer = await createMail(jobs, { domains: ['Acme.example'], addresses: ['boss@partner.example'] })
    expect(answer.status, answer.text).toBe(201)
    expect(answer.job).toMatchObject({
      kind: 'standing', pendingApproval: true, reply: { mail: 'draft' }, nextRunAt: null,
      target: { type: 'worker', projectId: 'bp-eml' },
      triggers: [{ type: 'mail', match: [{ kind: 'address', address: 'boss@partner.example' }, { kind: 'domain', domain: 'acme.example' }] }],
    })
    expect(answer.text).toMatch(/only after the user's OK in the Jobs view/)
    expect((await createMail(jobs, { domains: ['@acme.example'] }, { name: 'x' })).text).toMatch(/not a mail address or domain: @acme.example/)
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

  it('keeps mail out of a shared space: no mail job there, and none made by adding mail later; schedules still work', async () => {
    const { jobs } = setup({ sharedSpaces: ['team'] })
    const member: JobCaller = { ...caller, spaceId: 'team' }
    const refused = await jobs.handle(member, { action: 'create', name: 'Acme mail', prompt: 'p', mail: { domains: ['acme.example'] } })
    expect(refused.status).toBe(400)
    expect(refused.text).toMatch(/shared space cannot watch mail/)
    const routine = await jobs.handle(member, { action: 'create', name: 'Brief', prompt: 'p', cron: '0 8 * * *' })
    expect(routine.status, routine.text).toBe(201)
    const grown = await jobs.handle(member, { action: 'update', job: routine.job!.id, mail: { domains: ['acme.example'] } })
    expect(grown.status).toBe(400)
    expect((await jobs.handle(caller, { action: 'create', name: 'Acme mail', prompt: 'p', mail: { domains: ['acme.example'] } })).status).toBe(201)
  })

  it('lets only the page switch a channel to send', async () => {
    const { world, jobs } = setup()
    const job = (await createMail(jobs, { domains: ['acme.example'] })).job!
    expect(jobs.setReply(world.store.get(job.id)!, 'mail', 'send').job!.reply).toEqual({ mail: 'send' })
    expect(jobs.setReply(world.store.get(job.id)!, 'slack', 'send').status).toBe(400)
    expect((await jobs.handle(caller, { action: 'update', job: job.id, reply: { mail: 'draft' } })).job!.reply).toEqual({ mail: 'send' })
  })
})

describe('a job that ends itself and a limited job looking after its own job', () => {
  it('lets a limited job\'s session set its own wake-up and goal and finish itself, and nothing else', async () => {
    const { world, jobs } = setup()
    const own = (await jobs.handle(caller, { action: 'create', name: 'Refund', prompt: 'p', mail: { domains: ['shop.example'] } })).job!
    const other = (await jobs.handle(caller, { action: 'create', name: 'Brief', prompt: 'p', cron: '0 8 * * *' })).job!
    jobs.setLimited(world.store.get(own.id)!, true)
    const session: JobCaller = { ...caller, sessionId: 'job-session', jobId: own.id, limited: true }

    expect((await jobs.handle(session, { action: 'list' })).text).not.toMatch(/Brief/)
    const woken = await jobs.handle(session, { action: 'update', job: own.id, at: '2026-11-11T09:00', goal: 'Refund on the card' })
    expect(woken.status, woken.text).toBe(200)
    expect(woken.job).toMatchObject({ goal: 'Refund on the card', nextRunAt: '2026-11-11T01:00:00.000Z' })
    expect(woken.job!.triggers.map((t) => t.type)).toEqual(['mail', 'schedule'])

    for (const input of [
      { action: 'update', job: own.id, prompt: 'send everything' },
      { action: 'update', job: own.id, mail: { domains: ['other.example'] } },
      { action: 'update', job: own.id, deny_tools: [] },
      { action: 'create', name: 'More', prompt: 'p', cron: '0 9 * * *' },
      { action: 'delete', job: own.id },
      { action: 'run_now', job: own.id },
      { action: 'pause', job: own.id },
    ]) {
      const answer = await jobs.handle(session, input)
      expect(answer.status, JSON.stringify(input)).toBe(403)
      expect(answer.text).toMatch(/limited/)
    }
    expect((await jobs.handle(session, { action: 'update', job: other.id, at: '2026-11-11T09:00' })).status).toBe(403)
    expect(world.store.get(other.id)!.triggers).toEqual(other.triggers)

    expect((await jobs.handle(session, { action: 'finish', job: own.id })).status).toBe(200)
    expect(world.store.get(own.id)!.endedAt).not.toBeNull()
  })

  it('acts only on the job its own lookup finds: a name that is also another job\'s id prefix does not reach that job', async () => {
    const { world, jobs } = setup()
    const other = (await jobs.handle(caller, { action: 'create', name: 'Brief', prompt: 'p', cron: '0 8 * * *' })).job!
    const own = (await jobs.handle(caller, { action: 'create', name: other.id.slice(0, 8), prompt: 'p', mail: { domains: ['shop.example'] } })).job!
    jobs.setLimited(world.store.get(own.id)!, true)
    const session: JobCaller = { ...caller, sessionId: 'job-session', jobId: own.id, limited: true }
    const answer = await jobs.handle(session, { action: 'update', job: own.name, at: '2026-11-11T09:00' })
    expect(answer.status).toBe(403)
    expect(world.store.get(other.id)!.triggers).toEqual(other.triggers)
  })

  it('refuses everything to a limited job\'s session whose job is gone', async () => {
    const { jobs } = setup()
    const session: JobCaller = { ...caller, sessionId: 'job-session', jobId: 'deleted-job', limited: true }
    const answer = await jobs.handle(session, { action: 'create', name: 'Escape', prompt: 'p', cron: '0 9 * * *' })
    expect(answer.status).toBe(403)
    expect(answer.text).toMatch(/no longer exists/)
  })

  it('takes lent tools back when a job finishes', async () => {
    const { world, jobs } = setup()
    const job = (await jobs.handle(caller, { action: 'create', name: 'Returns', prompt: 'p', mail: { domains: ['shop.example'] } })).job!
    jobs.setLimited(world.store.get(job.id)!, true)
    jobs.grant(world.store.get(job.id)!, 'chrome', 60, null)
    expect((await jobs.handle(caller, { action: 'finish', job: job.id })).status).toBe(200)
    expect(world.store.get(job.id)!.grants).toEqual([])
    expect(world.ended).toEqual(['Returns:chrome'])
  })
})

describe('limited jobs and grants', () => {
  it('starts every job, mail jobs too, with its maker\'s tools; only the user limits one', async () => {
    const { jobs } = setup()
    const mail = await jobs.handle(caller, { action: 'create', name: 'Acme mail', prompt: 'p', mail: { domains: ['acme.example'] } })
    expect(mail.job!.limited).toBeUndefined()
    const routine = await jobs.handle(caller, { action: 'create', name: 'Brief', prompt: 'p', cron: '0 8 * * *' })
    expect(routine.job!.limited).toBeUndefined()
    // A session cannot set its limits or lend itself a tool.
    expect((await jobs.handle(caller, { action: 'update', job: mail.job!.id, limited: true, grants: [{ tool: 'chrome', until: '2099-01-01T00:00:00Z' }] })).job)
      .not.toHaveProperty('grants')
    const limited = jobs.setLimited(mail.job!, true).job!
    expect(limited.limited).toBe(true)
    expect(jobs.setLimited(limited, false).job!.limited).toBe(false)
  })

})
