import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-next-step-'))
process.env.EML_COCKPIT_HOME = home

import { reminder } from '../src/domain/turn-end.js'

type NextStep = typeof import('../src/application/next-step.js')
const NEXT = reminder(['next'], { tool: false })
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
    task: { status: 'active', properties: {} }, owner: 'lasse', sessionId: 'me', runStartedAt: RUN, jobs: [], otherSession: false, steps: [], ...patch,
  })

  it('finds none for an open task with nothing ahead', () => {
    expect(mod.nextTriggers(facts())).toEqual([])
  })

  it('counts a wait on the user only from this run or a newer one', () => {
    const wait = (since: string) => facts({ task: { status: 'active', properties: { waiting_on: { who: 'lasse', why: 'go?', since, session_id: 's' } } } })
    expect(mod.nextTriggers(wait('2026-11-19T09:00:00.000Z'))).toEqual(['wait'])
    expect(mod.nextTriggers(wait('2026-11-18T09:00:00.000Z'))).toEqual([])
  })

  it('counts any wait this session set since its run began, and nobody else\'s wait on someone else', () => {
    const wait = (patch: Record<string, unknown>) => facts({ task: { status: 'active', properties: { waits: [{ id: 'me', who: 'dominik', kind: 'review', why: 'check the numbers', since: '2026-11-19T09:00:00.000Z', session_id: 'me', ...patch }] } } })
    expect(mod.nextTriggers(wait({}))).toEqual(['wait'])
    expect(mod.nextTriggers(wait({ who: 'Acme', kind: 'outside' }))).toEqual(['wait'])
    expect(mod.nextTriggers(wait({ since: '2026-11-18T09:00:00.000Z' }))).toEqual([])
    expect(mod.nextTriggers(wait({ id: 'other', session_id: 'other' }))).toEqual([])
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
    /** The provider's chat sessions have the end_turn tool (default: they do). */
    tool?: boolean
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
      endTurnTool: (id) => ledger.get(id)?.runtime === 'sdk' && (opts.tool ?? true),
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
    const { ledger, brain, check, delivered, waited } = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } })
    ledger.recordSpawn('w1-1', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-1')
    expect(delivered).toEqual([`w1-1: ${NEXT}`])
    expect(brain.posts).toEqual([])
    await check.turnEnded('w1-1')
    expect(delivered).toHaveLength(1)
    expect(brain.posts[0]).toEqual({ path: '/task/t1/track', body: { waits: [{ id: 'w1-1', who: 'lasse', kind: 'stopped', why: mod.NO_NEXT_STEP, since: '2026-11-19T10:00:00.000Z', session_id: 'w1-1' }] } })
    expect(ledger.get('w1-1')!.attention).toMatchObject({ kind: 'question', reason: mod.NO_NEXT_STEP })
    expect(waited).toEqual(['w1-1'])
  })

  it('flags at once when the prompt does not arrive', async () => {
    const { ledger, brain, check } = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } }, { delivers: false })
    ledger.recordSpawn('w1-2', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-2')
    expect(brain.posts[0].body.waits).toEqual([expect.objectContaining({ why: mod.NO_NEXT_STEP })])
  })

  it('adds its stopped wait next to another session\'s wait on the task', async () => {
    const other = { id: 'u1', who: 'kim', kind: 'outside', why: 'reply to the offer', since: '2026-11-19T09:00:00.000Z', session_id: 'u1' }
    const { ledger, brain, check } = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas', waits: [other] } } }, { delivers: false })
    ledger.recordSpawn('w1-x', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-x')
    expect(brain.posts[0].body.waits).toEqual([other, expect.objectContaining({ id: 'w1-x', kind: 'stopped' })])
  })

  it('leaves a worker alone whose task has a next step after the prompt', async () => {
    const tasks = { t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } as Record<string, unknown> } }
    const { ledger, brain, check, delivered } = setup(tasks)
    ledger.recordSpawn('w1-3', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-3')
    tasks.t1.properties.waiting_on = { who: 'lasse', why: 'Send the follow-up?', since: '2026-11-19T09:30:00.000Z', session_id: 'w1-3' }
    await check.turnEnded('w1-3')
    expect(delivered).toHaveLength(1)
    expect(brain.posts).toEqual([])
  })

  it('checks this cockpit\'s own workers in a shared space too', async () => {
    const { ledger, brain, check, delivered } = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } }, { space: { shared: true } })
    ledger.recordSpawn('w1-4', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-4')
    expect(delivered).toEqual([`w1-4: ${NEXT}`])
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
    const { ledger, check, delivered } = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } })
    ledger.recordSpawn('own-6', null, 'bp-eml', 'claude', false, 't1')
    ledger.recordSpawn('w1-6', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-6')
    expect(delivered).toEqual([])
  })

  it('puts the check off while the user has the worker open, and runs it on the tick once they left', async () => {
    const { ledger, check, delivered, state } = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } }, { watched: true })
    ledger.recordSpawn('w1-7', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-7')
    await check.tick()
    expect(delivered).toEqual([])
    state.watched = false
    await check.tick()
    expect(delivered).toHaveLength(1)
  })

  it('archives a job worker that rescheduled quietly, and keeps one that asks the user', async () => {
    const tasks = { t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } as Record<string, unknown> } }
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
      p: { id: 'p', status: 'active', properties: { delegate: 'atlas' }, relations: [{ source_id: 's1', target_id: 'p', relation: 'part_of' }] },
      s1: { id: 's1', status: 'planned', properties: { checkpoint: 'after', delegate: 'atlas', depends_on: ['d'] } },
      d: { id: 'd', status: 'invalidated', properties: {} },
    }
    const dropped = setup(tasks)
    dropped.ledger.recordSpawn('w1-9', null, 'bp-eml', 'claude', true, 'p')
    await dropped.check.turnEnded('w1-9')
    expect(dropped.delivered).toHaveLength(1)

    tasks.d = { id: 'd', status: 'active', properties: { delegate: 'atlas' } }
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

  it('checks a worker left open in a pane once its answer stays unseen, not while the user has seen it', async () => {
    const seenOne = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } }, { watched: true })
    seenOne.ledger.recordSpawn('w1-13', null, 'bp-eml', 'claude', true, 't1')
    await seenOne.check.turnEnded('w1-13')
    seenOne.state.seenAt = seenOne.state.now.toISOString()
    later(seenOne.state, mod.UNSEEN_GRACE_MS)
    await seenOne.check.tick()
    expect(seenOne.delivered).toEqual([])

    const unseen = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } }, { watched: true })
    unseen.ledger.recordSpawn('w2-13', null, 'bp-eml', 'claude', true, 't1')
    await unseen.check.turnEnded('w2-13')
    await unseen.check.tick()
    expect(unseen.delivered).toEqual([])
    later(unseen.state, mod.UNSEEN_GRACE_MS)
    await unseen.check.tick()
    expect(unseen.delivered).toEqual([`w2-13: ${NEXT}`])
  })

  it('checks a session by its task: one handed to an agent gets the full check, also when the user started the session', async () => {
    const { ledger, brain, check, delivered } = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } })
    ledger.recordSpawn('own-15', null, 'bp-eml', 'claude', false, 't1')
    ledger.setRuntime('own-15', 'sdk')
    await check.turnEnded('own-15')
    expect(delivered).toEqual([`own-15: ${reminder(['next'])}`])
    await check.turnEnded('own-15')
    expect(brain.posts[0].body.waits).toEqual([expect.objectContaining({ id: 'own-15', kind: 'stopped', why: mod.NO_NEXT_STEP })])
  })

  it('sends no reminder when the turn\'s call left a next step: a wait on another member, or a check', async () => {
    const tasks = { t1: { id: 't1', status: 'active', properties: { delegate: 'atlas', waits: [{ id: 'w1-16', who: 'dominik', kind: 'review', why: 'check the numbers', since: '2026-11-19T09:30:00.000Z', session_id: 'w1-16' }] } } }
    const waited = setup(tasks)
    waited.ledger.recordSpawn('w1-16', null, 'bp-eml', 'claude', true, 't1')
    await waited.check.turnEnded('w1-16', { endedAt: waited.state.now.toISOString(), call: { result: 'Numbers are with Dominik', next: { who: 'dominik', what: 'check the numbers' } } })
    expect(waited.delivered).toEqual([])
    expect(waited.brain.posts).toEqual([])

    // next names the agent itself with a time: the check is a job of the task by the time the turn ends.
    const scheduled = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } }, { jobs: [job({ nextRunAt: '2026-11-27T10:00:00Z' })] })
    scheduled.ledger.recordSpawn('w2-16', null, 'bp-eml', 'claude', true, 't1')
    await scheduled.check.turnEnded('w2-16', { endedAt: scheduled.state.now.toISOString(), call: { result: 'No answer yet', next: { who: 'atlas', what: 'look again', when: '2026-11-27T10:00' } } })
    expect(scheduled.delivered).toEqual([])
    expect(scheduled.brain.posts).toEqual([])
  })

  it('sends no second reminder to a turn the chat already sent back: the task waits on the user at once', async () => {
    const { ledger, brain, check, delivered, waited, state } = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } })
    ledger.recordSpawn('w1-17', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-17', { endedAt: state.now.toISOString(), call: { result: 'Half done' }, reminded: true })
    expect(delivered).toEqual([])
    expect(brain.posts[0].body.waits).toEqual([expect.objectContaining({ id: 'w1-17', kind: 'stopped', why: mod.NO_NEXT_STEP })])
    expect(waited).toEqual(['w1-17'])
  })

  it('puts the task on the user as stopped when a worker stayed silent after its reminder: the chat\'s review flag is no next step', async () => {
    const { ledger, brain, check, delivered, state } = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } })
    ledger.recordSpawn('w1-19', null, 'bp-eml', 'claude', true, 't1')
    // What the chat leaves on a worker that said nothing (attentionAfterTurn); the router put no wait on the task for it.
    ledger.setAttention('w1-19', { kind: 'review', reason: null })
    await check.turnEnded('w1-19', { endedAt: state.now.toISOString(), call: null, reminded: true })
    expect(delivered).toEqual([])
    expect(brain.posts[0].body.waits).toEqual([expect.objectContaining({ id: 'w1-19', kind: 'stopped', why: mod.NO_NEXT_STEP })])
    expect(ledger.get('w1-19')!.attention).toMatchObject({ kind: 'question', reason: mod.NO_NEXT_STEP })
  })

  it('sends nothing when the task was closed after the turn ended, while the check was put off', async () => {
    const tasks = { t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } }
    const { ledger, brain, check, delivered, state } = setup(tasks, { watched: true })
    ledger.recordSpawn('w1-19', null, 'bp-eml', 'claude', true, 't1')
    await check.turnEnded('w1-19')
    tasks.t1.status = 'invalidated'
    state.watched = false
    await check.tick()
    expect(delivered).toEqual([])
    expect(brain.posts).toEqual([])
  })

  it('tells a chat session to call and a terminal the way without the tool', async () => {
    const { ledger, check, delivered } = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } })
    ledger.recordSpawn('w1-20', null, 'bp-eml', 'claude', true, 't1')
    ledger.recordSpawn('w2-20', null, 'bp-eml', 'claude', true, 't1')
    ledger.setRuntime('w1-20', 'sdk')
    ledger.archive('w2-20')
    await check.turnEnded('w1-20')
    expect(delivered).toEqual([`w1-20: ${reminder(['next'])}`])
    expect(NEXT).not.toBe(reminder(['next']))
    expect(NEXT).toContain('Handoff block')
  })

  it('tells a chat session whose provider has no end_turn tool the way without it', async () => {
    const { ledger, check, delivered } = setup({ t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } } }, { tool: false })
    ledger.recordSpawn('w1-21', null, 'bp-eml', 'codex', true, 't1')
    ledger.setRuntime('w1-21', 'sdk')
    await check.turnEnded('w1-21')
    expect(delivered).toEqual([`w1-21: ${NEXT}`])
  })

  it('sends the user\'s own session nothing, however long its answer stays unseen', async () => {
    const { ledger, brain, check, delivered, waited, state } = setup({ t1: { id: 't1', status: 'active', properties: {} } }, { watched: true })
    ledger.recordSpawn('own-10', null, 'bp-eml', 'claude', false, 't1')
    ledger.setRuntime('own-10', 'sdk')
    await check.turnEnded('own-10', { endedAt: state.now.toISOString() })
    later(state, mod.UNSEEN_GRACE_MS * 10)
    state.watched = false
    await check.tick()
    expect(delivered).toEqual([])
    expect(brain.posts).toEqual([])
    expect(waited).toEqual([])
    expect(ledger.get('own-10')!.attention).toBeNull()
  })

  it('leaves a runner\'s worker alone once its task was taken back: it is the user\'s conversation', async () => {
    const tasks = { t1: { id: 't1', status: 'active', properties: { delegate: 'atlas' } as Record<string, unknown> } }
    const { ledger, brain, check, delivered } = setup(tasks)
    ledger.recordSpawn('w1-30', null, 'bp-eml', 'claude', true, 't1')
    // Work on it now took the delegation off while the session was open.
    delete tasks.t1.properties.delegate
    await check.turnEnded('w1-30')
    await check.turnEnded('w1-30')
    expect(delivered).toEqual([])
    expect(brain.posts).toEqual([])
    // Handed over again: the same session is checked again.
    tasks.t1.properties.delegate = 'atlas'
    await check.turnEnded('w1-30')
    expect(delivered).toEqual([`w1-30: ${NEXT}`])
  })

  it('still checks a worker a session or a job started on a task that is not handed over', async () => {
    const { ledger, check, delivered } = setup({ t1: { id: 't1', status: 'active', properties: {} } })
    ledger.expectParent('w1-31', 'main-31')
    ledger.recordSpawn('w1-31', null, 'bp-eml', 'claude', true, 't1')
    ledger.recordSpawn('w1-32', null, 'bp-eml', 'claude', true, 't1')
    ledger.setJobId('w1-32', 'job-32')
    await check.turnEnded('w1-31')
    expect(delivered).toEqual([`w1-31: ${NEXT}`])
  })
})
