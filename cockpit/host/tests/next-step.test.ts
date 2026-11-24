import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-next-step-'))
process.env.EML_COCKPIT_HOME = home

type NextStep = typeof import('../src/application/next-step.js')
type Ledger = typeof import('../src/session-ledger.js')['SessionLedger']

const RUN = '2026-11-19T08:00:00.000Z'
const job = (patch: Partial<import('../src/application/next-step.js').JobFacts> = {}) =>
  ({ ended: false, held: false, nextRunAt: null, channel: false, runWaiting: false, ...patch })

function fakeBrain(tasks: Record<string, Record<string, unknown>>) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  return {
    posts,
    async get(path: string) {
      const task = tasks[path.replace('/engram/', '')]
      if (!task) throw new Error('not found')
      return task
    },
    async post(path: string, body: Record<string, unknown>) {
      posts.push({ path, body })
      return {}
    },
  }
}

describe('next triggers', () => {
  let mod: NextStep
  beforeAll(async () => { mod = await import('../src/application/next-step.js') })

  const facts = (patch: Partial<Parameters<NextStep['nextTriggers']>[0]> = {}) => ({
    task: { status: 'active', properties: {} }, owner: 'lasse', runStartedAt: RUN, jobs: [], otherSession: false, steps: [], ...patch,
  })

  it('finds none for an open task with nothing ahead', () => {
    expect(mod.nextTriggers(facts())).toEqual([])
  })

  it('counts a wait on the user only from this run or a newer one', () => {
    const wait = (since: string) => facts({ task: { status: 'active', properties: { waiting_on: { who: 'lasse', why: 'go?', since, session_id: 's' } } } })
    expect(mod.nextTriggers(wait('2026-11-19T09:00:00.000Z'))).toEqual(['question'])
    expect(mod.nextTriggers(wait('2026-11-18T09:00:00.000Z'))).toEqual([])
  })

  it('counts a job that will run again, not an ended or held one', () => {
    expect(mod.nextTriggers(facts({ jobs: [job({ nextRunAt: '2026-11-20T10:00:00Z' })] }))).toEqual(['job'])
    expect(mod.nextTriggers(facts({ jobs: [job({ channel: true })] }))).toEqual(['job'])
    expect(mod.nextTriggers(facts({ jobs: [job({ runWaiting: true })] }))).toEqual(['job'])
    expect(mod.nextTriggers(facts({ jobs: [job({ nextRunAt: 'x', ended: true }), job({ nextRunAt: 'x', held: true }), job()] }))).toEqual([])
  })

  it('counts only steps the runner can move', () => {
    const step = (patch: Record<string, unknown>) => ({ status: 'planned', checkpoint: 'after', delegated: true, depsCanResolve: true, ...patch })
    expect(mod.nextTriggers(facts({ steps: [step({ status: 'active', checkpoint: undefined })] }))).toEqual(['step'])
    expect(mod.nextTriggers(facts({ steps: [step({})] }))).toEqual(['step'])
    expect(mod.nextTriggers(facts({ steps: [step({ checkpoint: undefined }), step({ delegated: false }), step({ depsCanResolve: false })] }))).toEqual([])
    // A planned step under a task that is not active waits with its plan.
    expect(mod.nextTriggers(facts({ task: { status: 'planned', properties: {} }, steps: [step({})] }))).toEqual([])
  })
})

describe('next-step check', () => {
  let mod: NextStep
  let SessionLedger: Ledger
  beforeAll(async () => {
    mod = await import('../src/application/next-step.js')
    SessionLedger = (await import('../src/session-ledger.js')).SessionLedger
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const setup = (tasks: Record<string, Record<string, unknown>>, opts: {
    space?: { shared: boolean }
    jobs?: ReturnType<typeof job>[]
    watched?: boolean
    delivers?: boolean
  } = {}) => {
    const ledger = new SessionLedger()
    // The ledger file outlives a test: earlier tests' sessions are put away.
    for (const e of ledger.list()) ledger.archive(e.sessionId)
    const brain = fakeBrain(tasks)
    const delivered: string[] = []
    const waited: string[] = []
    const quiet: string[] = []
    const state = { watched: opts.watched ?? false, seenAt: '', working: false, now: new Date('2026-11-19T10:00:00Z') }
    const check = mod.createNextStepCheck({
      ledger, spaces: { resolve: () => (opts.space ?? { shared: false }) as never }, brain: () => brain,
      owner: 'lasse', log: () => {},
      jobsOf: () => opts.jobs ?? [],
      runStartedAt: () => RUN,
      working: () => state.working,
      watched: () => state.watched,
      seen: (_id, since) => state.seenAt !== '' && state.seenAt >= since,
      deliver: async (id, text) => { delivered.push(`${id}: ${text}`); return opts.delivers ?? true },
      waiting: (id) => waited.push(id),
      quiet: (id) => quiet.push(id),
      now: () => state.now,
    })
    return { ledger, brain, check, delivered, waited, quiet, state }
  }

  it('prompts once, then puts the task on the user when the next stop still has no next step', async () => {
    const { ledger, brain, check, delivered, waited } = setup({ t1: { id: 't1', status: 'active', properties: {} } })
    ledger.recordSpawn('w1-1', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-1')
    expect(delivered).toEqual([`w1-1: ${mod.NEXT_STEP_PROMPT}`])
    expect(brain.posts).toEqual([])
    await check.turnEnded('w1-1')
    expect(delivered).toHaveLength(1)
    expect(brain.posts[0]).toEqual({ path: '/task/t1/track', body: { waits: [{ id: 'w1-1', who: 'lasse', kind: 'stopped', why: mod.NO_NEXT_STEP, since: '2026-11-19T10:00:00.000Z', session_id: 'w1-1' }] } })
    expect(ledger.get('w1-1')!.attention).toMatchObject({ kind: 'question', reason: mod.NO_NEXT_STEP })
    expect(waited).toEqual(['w1-1'])
  })

  it('flags at once when the prompt does not arrive', async () => {
    const { ledger, brain, check } = setup({ t1: { id: 't1', status: 'active', properties: {} } }, { delivers: false })
    ledger.recordSpawn('w1-2', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-2')
    expect(brain.posts[0].body.waits).toEqual([expect.objectContaining({ why: mod.NO_NEXT_STEP })])
  })

  it('adds its stopped wait next to another session\'s wait on the task', async () => {
    const other = { id: 'u1', who: 'kim', kind: 'outside', why: 'reply to the offer', since: '2026-11-19T09:00:00.000Z', session_id: 'u1' }
    const { ledger, brain, check } = setup({ t1: { id: 't1', status: 'active', properties: { waits: [other] } } }, { delivers: false })
    ledger.recordSpawn('w1-x', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-x')
    expect(brain.posts[0].body.waits).toEqual([other, expect.objectContaining({ id: 'w1-x', kind: 'stopped' })])
  })

  it('leaves a worker alone whose task has a next step after the prompt', async () => {
    const tasks = { t1: { id: 't1', status: 'active', properties: {} as Record<string, unknown> } }
    const { ledger, brain, check, delivered } = setup(tasks)
    ledger.recordSpawn('w1-3', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-3')
    tasks.t1.properties.waiting_on = { who: 'lasse', why: 'Send the follow-up?', since: '2026-11-19T09:30:00.000Z', session_id: 'w1-3' }
    await check.turnEnded('w1-3')
    expect(delivered).toHaveLength(1)
    expect(brain.posts).toEqual([])
  })

  it('checks this cockpit\'s own workers in a shared space too', async () => {
    const { ledger, brain, check, delivered } = setup({ t1: { id: 't1', status: 'active', properties: {} } }, { space: { shared: true } })
    ledger.recordSpawn('w1-4', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-4')
    expect(delivered).toEqual([`w1-4: ${mod.NEXT_STEP_PROMPT}`])
    await check.turnEnded('w1-4')
    expect(brain.posts[0].body.waits).toEqual([expect.objectContaining({ who: 'lasse', why: mod.NO_NEXT_STEP })])
  })

  it('never prompts a worker on a closed task', async () => {
    const { ledger, check, delivered } = setup({ t2: { id: 't2', status: 'resolved', properties: {} } })
    ledger.recordSpawn('closed-5', null, 'bp-eml', 'claude', true, 't2')
    await check.turnEnded('closed-5')
    expect(delivered).toEqual([])
  })

  it('counts the user\'s own session on the task as a next step', async () => {
    const { ledger, check, delivered } = setup({ t1: { id: 't1', status: 'active', properties: {} } })
    ledger.recordSpawn('own-6', null, 'bp-eml', 'claude', false, 't1')
    ledger.recordSpawn('w1-6', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-6')
    expect(delivered).toEqual([])
  })

  it('puts the check off while the user has the worker open, and runs it on the tick once they left', async () => {
    const { ledger, check, delivered, state } = setup({ t1: { id: 't1', status: 'active', properties: {} } }, { watched: true })
    ledger.recordSpawn('w1-7', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-7')
    await check.tick()
    expect(delivered).toEqual([])
    state.watched = false
    await check.tick()
    expect(delivered).toHaveLength(1)
  })

  it('archives a job worker that rescheduled quietly, and keeps one that asks the user', async () => {
    const tasks = { t1: { id: 't1', status: 'active', properties: {} as Record<string, unknown> } }
    const { ledger, check, delivered, quiet } = setup(tasks, { jobs: [job({ nextRunAt: '2026-11-20T10:00:00Z' })] })
    ledger.recordSpawn('j1-8', null, 'bp-eml', 'claude', true, 't1')
    ledger.setJobId('j1-8', 'job-1')
    ledger.setAttention('j1-8', { kind: 'done', reason: 'Not answered yet; next check tomorrow 10:00' })
    await check.turnEnded('j1-8')
    expect(quiet).toEqual(['j1-8'])
    expect(delivered).toEqual([])

    ledger.recordSpawn('j2-8', null, 'bp-eml', 'claude', true, 't1')
    ledger.setJobId('j2-8', 'job-1')
    ledger.setAttention('j2-8', { kind: 'question', reason: 'Send the follow-up?' })
    tasks.t1.properties.waiting_on = { who: 'lasse', why: 'Send the follow-up?', since: '2026-11-19T09:30:00.000Z', session_id: 'j2-8' }
    await check.turnEnded('j2-8')
    expect(quiet).toEqual(['j1-8'])
  })

  it('counts a runnable step and not one whose dependency was dropped', async () => {
    const tasks: Record<string, Record<string, unknown>> = {
      p: { id: 'p', status: 'active', properties: {}, relations: [{ source_id: 's1', target_id: 'p', relation: 'part_of' }] },
      s1: { id: 's1', status: 'planned', properties: { checkpoint: 'after', delegate: 'atlas', depends_on: ['d'] } },
      d: { id: 'd', status: 'invalidated', properties: {} },
    }
    const dropped = setup(tasks)
    dropped.ledger.recordSpawn('w1-9', null, 'bp-eml', 'claude', true, 'p')
    await dropped.check.turnEnded('w1-9')
    expect(dropped.delivered).toHaveLength(1)

    tasks.d = { id: 'd', status: 'active', properties: {} }
    const open = setup(tasks)
    open.ledger.recordSpawn('w2-9', null, 'bp-eml', 'claude', true, 'p')
    await open.check.turnEnded('w2-9')
    expect(open.delivered).toEqual([])

    // A step without a delegate is nobody's to start: no trigger.
    tasks.s1 = { id: 's1', status: 'planned', properties: { checkpoint: 'after', depends_on: ['d'] } }
    const undelegated = setup(tasks)
    undelegated.ledger.recordSpawn('w3-9', null, 'bp-eml', 'claude', true, 'p')
    await undelegated.check.turnEnded('w3-9')
    expect(undelegated.delivered).toHaveLength(1)
  })

  const later = (state: { now: Date }, ms: number) => { state.now = new Date(state.now.getTime() + ms) }

  it('asks an own chat session for its status once its silent answer stays unseen, and only once', async () => {
    const { ledger, brain, check, delivered, waited, state } = setup({ t1: { id: 't1', status: 'active', properties: {} } }, { watched: true })
    ledger.recordSpawn('own-10', null, 'bp-eml', 'claude', false, 't1')
    ledger.setRuntime('own-10', 'sdk')
    await check.turnEnded('own-10', { handoff: false, endedAt: state.now.toISOString() })
    expect(delivered).toEqual([])
    later(state, mod.UNSEEN_GRACE_MS - 1)
    await check.tick()
    expect(delivered).toEqual([])
    later(state, 1)
    await check.tick()
    expect(delivered).toEqual([`own-10: ${mod.OWN_STATUS_PROMPT}`])
    // The turn the prompt started is its answer: not checked again, and nothing waits on the user.
    await check.turnEnded('own-10', { handoff: false, endedAt: state.now.toISOString() })
    later(state, mod.UNSEEN_GRACE_MS)
    await check.tick()
    expect(delivered).toHaveLength(1)
    expect(brain.posts).toEqual([])
    expect(waited).toEqual([])
    expect(ledger.get('own-10')!.attention).toBeNull()
  })

  it('leaves an own session alone that the user saw, said how it stands, or runs in a terminal', async () => {
    const { ledger, check, delivered, state } = setup({ t1: { id: 't1', status: 'active', properties: {} } }, { watched: true })
    for (const id of ['own-11a', 'own-11b', 'own-11c', 'own-11d']) {
      ledger.recordSpawn(id, null, 'bp-eml', 'claude', false, 't1')
      if (id !== 'own-11d') ledger.setRuntime(id, 'sdk')
    }
    ledger.setAttention('own-11b', { kind: 'question', reason: 'Shall I start?' })
    await check.turnEnded('own-11a', { handoff: false, endedAt: state.now.toISOString() })
    await check.turnEnded('own-11b', { handoff: false, endedAt: state.now.toISOString() })
    await check.turnEnded('own-11c', { handoff: true, endedAt: state.now.toISOString() })
    await check.turnEnded('own-11d', { handoff: false, endedAt: state.now.toISOString() })
    state.seenAt = new Date(state.now.getTime() + 5_000).toISOString()
    later(state, mod.UNSEEN_GRACE_MS)
    await check.tick()
    expect(delivered).toEqual([])
  })

  it('counts a read mark that came just before the turn\'s end as seen', async () => {
    const { ledger, check, delivered, state } = setup({ t1: { id: 't1', status: 'active', properties: {} } }, { watched: true })
    ledger.recordSpawn('own-14', null, 'bp-eml', 'claude', false, 't1')
    ledger.setRuntime('own-14', 'sdk')
    state.seenAt = new Date(state.now.getTime() - 2_000).toISOString()
    await check.turnEnded('own-14', { handoff: false, endedAt: state.now.toISOString() })
    later(state, mod.UNSEEN_GRACE_MS)
    await check.tick()
    expect(delivered).toEqual([])
  })

  it('waits for an own session that is in a turn again, and skips a closed task', async () => {
    const { ledger, check, delivered, state } = setup({ t1: { id: 't1', status: 'active', properties: {} }, t2: { id: 't2', status: 'resolved', properties: {} } })
    ledger.recordSpawn('own-12', null, 'bp-eml', 'claude', false, 't1')
    ledger.recordSpawn('own-12c', null, 'bp-eml', 'claude', false, 't2')
    ledger.setRuntime('own-12', 'sdk')
    ledger.setRuntime('own-12c', 'sdk')
    await check.turnEnded('own-12', { handoff: false, endedAt: state.now.toISOString() })
    await check.turnEnded('own-12c', { handoff: false, endedAt: state.now.toISOString() })
    later(state, mod.UNSEEN_GRACE_MS)
    state.working = true
    await check.tick()
    expect(delivered).toEqual([])
    state.working = false
    await check.tick()
    expect(delivered).toEqual([`own-12: ${mod.OWN_STATUS_PROMPT}`])
  })

  it('checks a worker left open in a pane once its answer stays unseen, not while the user has seen it', async () => {
    const seenOne = setup({ t1: { id: 't1', status: 'active', properties: {} } }, { watched: true })
    seenOne.ledger.recordSpawn('w1-13', null, 'bp-eml', 'claude', true, 't1')
    await seenOne.check.turnEnded('w1-13')
    seenOne.state.seenAt = seenOne.state.now.toISOString()
    later(seenOne.state, mod.UNSEEN_GRACE_MS)
    await seenOne.check.tick()
    expect(seenOne.delivered).toEqual([])

    const unseen = setup({ t1: { id: 't1', status: 'active', properties: {} } }, { watched: true })
    unseen.ledger.recordSpawn('w2-13', null, 'bp-eml', 'claude', true, 't1')
    await unseen.check.turnEnded('w2-13')
    await unseen.check.tick()
    expect(unseen.delivered).toEqual([])
    later(unseen.state, mod.UNSEEN_GRACE_MS)
    await unseen.check.tick()
    expect(unseen.delivered).toEqual([`w2-13: ${mod.NEXT_STEP_PROMPT}`])
  })
})
