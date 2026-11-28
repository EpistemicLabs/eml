import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageRequest } from '../src/application/deliver-message.js'
import type { DeliveryOutcome } from '../src/domain/session-delivery.js'
import type { SpawnRequest } from '../src/domain/spawn-request.js'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-follow-replacement-'))
process.env.EML_COCKPIT_HOME = home

type Domain = typeof import('../src/domain/task-replacement.js')
type App = typeof import('../src/application/follow-replacement.js')
type Router = typeof import('../src/application/task-router.js')
type Ledger = typeof import('../src/session-ledger.js')['SessionLedger']

type Task = { id: string; status: string; title?: string; properties?: Record<string, unknown>; relations?: Array<{ relation: string; source_id: string; target_id: string }>; entries?: Array<{ kind: string; text: string }> }

const supersedes = (source: string, target: string) => ({ relation: 'supersedes', source_id: source, target_id: target })

/**
 * A brain of several tasks: reads by id with their journal, every write recorded and its note kept in the journal.
 * `down` makes reads of those ids fail as an unreachable brain does; `failPosts` fails that many writes first.
 */
function fakeBrain(tasks: Task[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const brain = {
    posts,
    down: new Set<string>(),
    failPosts: 0,
    journal: (id: string) => posts.filter((p) => p.path === `/task/${id}/track` && typeof p.body.text === 'string').map((p) => p.body.text as string),
    async get(path: string) {
      const id = decodeURIComponent(path.split('/').pop()!)
      if (brain.down.has(id)) throw Object.assign(new Error('brain did not answer'), { status: 503 })
      const task = byId.get(id)
      if (!task) throw Object.assign(new Error('not found'), { status: 404 })
      return structuredClone(task)
    },
    async post(path: string, body: Record<string, unknown>) {
      if (brain.failPosts > 0) { brain.failPosts--; throw Object.assign(new Error('brain did not answer'), { status: 503 }) }
      const { base_rev: _rev, ...rest } = body
      posts.push({ path, body: rest })
      const task = byId.get(decodeURIComponent(path.split('/')[2]!))
      if (task && typeof rest.text === 'string') task.entries = [...(task.entries ?? []), { kind: 'note', text: rest.text }]
      return {}
    },
  }
  return brain
}

const HANDOFF = '### Handoff\nResult: Design board for the four points is done.'

describe('where a replaced task goes on (domain)', () => {
  let d: Domain
  beforeAll(async () => { d = await import('../src/domain/task-replacement.js') })

  it('reads the tasks that replaced one from its supersedes relations, not its own or other links', () => {
    expect(d.replacingIds({ id: 'x', status: 'superseded', relations: [supersedes('y', 'x'), supersedes('y', 'x'), supersedes('x', 'w'), { relation: 'related_to', source_id: 'z', target_id: 'x' }] })).toEqual(['y'])
    expect(d.replacingIds({ id: 'x', status: 'superseded' })).toEqual([])
  })

  it('finds the open replacement, follows a chain of replacements, and stops at a done or dropped one', async () => {
    const tasks: Record<string, Task> = {
      x: { id: 'x', status: 'superseded', relations: [supersedes('y', 'x')] },
      y: { id: 'y', status: 'superseded', relations: [supersedes('y', 'x'), supersedes('z', 'y')] },
      z: { id: 'z', status: 'active', relations: [supersedes('z', 'y')] },
      done: { id: 'done', status: 'superseded', relations: [supersedes('r', 'done')] },
      r: { id: 'r', status: 'resolved' },
    }
    const read = async (id: string) => tasks[id] ?? null
    expect(await d.findReplacement(read, tasks.x!)).toEqual({ kind: 'open', taskId: 'z' })
    expect(await d.findReplacement(read, tasks.done!)).toEqual({ kind: 'none' })
    expect(await d.findReplacement(read, { id: 'lone', status: 'superseded' })).toEqual({ kind: 'none' })
  })

  it('names several open replacements (the work was split) instead of picking one, survives a loop, and throws when a read fails', async () => {
    const tasks: Record<string, Task> = {
      x: { id: 'x', status: 'superseded', relations: [supersedes('a', 'x'), supersedes('b', 'x'), supersedes('gone', 'x')] },
      a: { id: 'a', status: 'planned' },
      b: { id: 'b', status: 'active' },
      down: { id: 'down', status: 'superseded', relations: [supersedes('a', 'down'), supersedes('unreachable', 'down')] },
      l1: { id: 'l1', status: 'superseded', relations: [supersedes('l2', 'l1')] },
      l2: { id: 'l2', status: 'superseded', relations: [supersedes('l1', 'l2')] },
    }
    const read = async (id: string) => { if (id === 'unreachable') throw new Error('brain down'); return tasks[id] ?? null }
    expect(await d.findReplacement(read, tasks.x!)).toEqual({ kind: 'several', taskIds: ['a', 'b'] })
    expect(await d.findReplacement(read, tasks.l1!)).toEqual({ kind: 'none' })
    // A brain that did not answer is not "nothing replaced it".
    await expect(d.findReplacement(read, tasks.down!)).rejects.toThrow('brain down')
  })

  it('moves when nobody holds the replacement or the session holds it itself; otherwise the holder wins', () => {
    expect(d.followDecision('s1', null)).toEqual({ kind: 'move' })
    expect(d.followDecision('s1', { kind: 'session', session: { sessionId: 's1' } })).toEqual({ kind: 'move' })
    expect(d.followDecision('s1', { kind: 'session', session: { sessionId: 'h' } })).toEqual({ kind: 'held', holder: { kind: 'session', sessionId: 'h' } })
    expect(d.followDecision('s1', { kind: 'request', request: { id: 'q' } })).toEqual({ kind: 'held', holder: { kind: 'request', requestId: 'q' } })
  })
})

describe('a session following its replaced task (host)', () => {
  let app: App
  let router: Router
  let SessionLedger: Ledger
  beforeAll(async () => {
    app = await import('../src/application/follow-replacement.js')
    router = await import('../src/application/task-router.js')
    SessionLedger = (await import('../src/session-ledger.js')).SessionLedger
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const TASKS = (): Task[] => [
    { id: 'old', status: 'superseded', relations: [supersedes('new', 'old')] },
    { id: 'new', status: 'active', title: 'sub-task-results', properties: { display_title: 'Bring sub-task results to the parent' }, relations: [supersedes('new', 'old')] },
  ]

  const setup = (opts: { tasks?: Task[]; working?: string[]; pending?: SpawnRequest[]; outcome?: DeliveryOutcome; contextTokens?: number | null } = {}) => {
    // The ledger is kept in the home's file: each case starts from an empty one.
    rmSync(join(home, 'sessions.json'), { force: true })
    const ledger = new SessionLedger()
    const brain = fakeBrain(opts.tasks ?? TASKS())
    const delivered: MessageRequest[] = []
    const putAway: string[] = []
    const finished: string[] = []
    const logs: string[] = []
    const follow = app.createFollowReplacement({
      ledger, spaces: { resolve: () => ({ shared: false }) as never }, brain: () => brain,
      pending: () => opts.pending ?? [],
      working: (id) => (opts.working ?? []).includes(id),
      deliver: async (r) => { delivered.push(r); return opts.outcome ?? 'delivered' },
      contextTokensOf: () => opts.contextTokens ?? null,
      putAway: async (id) => { putAway.push(id); ledger.archive(id); return null },
      log: (l) => logs.push(l),
    })
    const r = router.createTaskRouter({
      ledger, spaces: { resolve: () => ({ shared: false }) as never }, brain: () => brain, owner: 'lasse', follow,
      finished: (id) => finished.push(id), log: (l) => logs.push(l), now: () => new Date('2026-11-27T15:10:00Z'),
    })
    /** A router as after a host restart: it remembers nothing it routed before. */
    const restarted = () => router.createTaskRouter({
      ledger, spaces: { resolve: () => ({ shared: false }) as never }, brain: () => brain, owner: 'lasse', follow,
      finished: (id) => finished.push(id), log: (l) => logs.push(l), now: () => new Date('2026-11-27T15:10:00Z'),
    })
    return { ledger, brain, follow, r, restarted, delivered, putAway, finished, logs }
  }

  it('moves a session in a turn onto the replacing task, writes both journals once and tells the session in its turn', async () => {
    const { ledger, brain, follow, delivered } = setup({ working: ['s1'] })
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
    expect(await follow.follow('s1')).toEqual({ kind: 'moved', from: 'old', to: 'new' })
    expect(ledger.get('s1')!.taskId).toBe('new')
    expect(brain.journal('new')).toEqual([expect.stringMatching(/s1.*moved here from task old/)])
    expect(brain.journal('old')).toEqual([expect.stringMatching(/s1.*moved to task new/)])
    expect(delivered).toEqual([expect.objectContaining({ target: 's1', from: null, text: expect.stringContaining('"Bring sub-task results to the parent" (new)') })])
    // Once moved there is nothing left to follow.
    expect(await follow.follow('s1')).toEqual({ kind: 'stays' })
    expect(brain.posts).toHaveLength(2)
  })

  it('does not wake a session that is not in a turn: it reads its new task when it next starts', async () => {
    const { ledger, follow, delivered } = setup()
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
    expect((await follow.follow('s1')).kind).toBe('moved')
    expect(delivered).toEqual([])
  })

  it('leaves alone a session on an open task, a put-away one, a scheduled run, and one with no clear replacement', async () => {
    const tasks: Task[] = [...TASKS(), { id: 'open', status: 'active' }, { id: 'split', status: 'superseded', relations: [supersedes('new', 'split'), supersedes('open', 'split')] }]
    const { ledger, brain, follow } = setup({ tasks })
    ledger.recordSpawn('on-open', null, 'bp-eml', 'claude', true, 'open')
    ledger.recordSpawn('away', null, 'bp-eml', 'claude', true, 'old')
    ledger.archive('away')
    ledger.recordSpawn('job', null, 'bp-eml', 'claude', true, 'old')
    ledger.setJobId('job', 'j1')
    ledger.recordSpawn('on-split', null, 'bp-eml', 'claude', true, 'split')
    for (const id of ['on-open', 'away', 'job', 'on-split']) expect(await follow.follow(id)).toEqual({ kind: 'stays' })
    expect(ledger.get('on-split')!.taskId).toBe('split')
    expect(brain.posts).toEqual([])
  })

  it('does not move a session beside the session that holds the replacement, nor beside a request starting on it', async () => {
    const { ledger, follow } = setup()
    ledger.recordSpawn('holder', null, 'bp-eml', 'claude', true, 'new')
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
    expect(await follow.follow('s1')).toEqual({ kind: 'held', from: 'old', to: 'new', holder: 'holder' })
    expect(ledger.get('s1')!.taskId).toBe('old')

    const starting = setup({ pending: [{ id: 'q1', projectId: 'bp-eml', prompt: 'p', title: null, fromSessionId: null, taskId: 'new', createdAt: '2026-11-27T15:00:00Z', origin: 'runner' }] })
    starting.ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
    expect(await starting.follow.follow('s1')).toEqual({ kind: 'held', from: 'old', to: 'new', holder: 'q1' })
  })

  it('moves once when the board\'s sweep and the router follow at the same time', async () => {
    const { ledger, brain, follow } = setup({ working: ['s1'] })
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
    follow.sweep(['old'])
    const [a, b] = await Promise.all([follow.follow('s1'), follow.follow('s1')])
    expect(a).toEqual({ kind: 'moved', from: 'old', to: 'new' })
    expect(b).toEqual(a)
    expect(brain.journal('new')).toHaveLength(1)
    expect(brain.journal('old')).toHaveLength(1)
  })

  it('says it failed when the brain does not answer, and moves on the next try with each journal line written once', async () => {
    const { ledger, brain, follow } = setup()
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
    brain.down.add('new')
    expect(await follow.follow('s1')).toEqual({ kind: 'failed' })
    brain.down.clear()
    // The first journal line lands, the second write fails: the session stays until both are in.
    const post = brain.post.bind(brain)
    let calls = 0
    brain.post = async (path, body) => { calls++; if (calls === 2) throw Object.assign(new Error('brain did not answer'), { status: 503 }); return post(path, body) }
    expect(await follow.follow('s1')).toEqual({ kind: 'failed' })
    expect(ledger.get('s1')!.taskId).toBe('old')
    expect(await follow.follow('s1')).toEqual({ kind: 'moved', from: 'old', to: 'new' })
    expect(brain.journal('new')).toHaveLength(1)
    expect(brain.journal('old')).toHaveLength(1)
  })

  it('checks a session the sweep found settled only once, while the router still checks it at each turn end', async () => {
    const { ledger, brain, follow, logs } = setup({ tasks: [{ id: 'old', status: 'superseded', relations: [supersedes('done', 'old')] }, { id: 'done', status: 'resolved' }] })
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
    const reads = () => logs.filter((l) => l.includes('stays on replaced task')).length
    follow.sweep(['old'])
    await vi.waitFor(() => expect(reads()).toBe(1))
    follow.sweep(['old'])
    follow.sweep(['old'])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(reads()).toBe(1)
    expect(await follow.follow('s1')).toEqual({ kind: 'stays' })
    expect(reads()).toBe(2)
    expect(brain.posts).toEqual([])
  })

  it('sweeps every live session on the replaced tasks the board read', async () => {
    const { ledger, follow } = setup()
    ledger.recordSpawn('a', null, 'bp-eml', 'claude', true, 'old')
    ledger.recordSpawn('b', null, 'bp-eml', 'claude', false, 'other')
    follow.sweep(['old'])
    await follow.follow('a')
    expect(ledger.get('a')!.taskId).toBe('new')
    expect(ledger.get('b')!.taskId).toBe('other')
  })

  describe('when its turn ends', () => {
    it('routes the hand-over onto the replacing task instead of dropping it, and keeps the session', async () => {
      const { ledger, brain, r, finished } = setup()
      ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
      await r.turnEnded('s1', HANDOFF)
      expect(ledger.get('s1')!.taskId).toBe('new')
      expect(brain.journal('new')).toEqual([expect.stringMatching(/moved here/), HANDOFF])
      expect(brain.journal('old')).toEqual([expect.stringMatching(/moved to task new/)])
      expect(finished).toEqual([])
    })

    it('gives the hand-over to the session holding the replacement, writes it there, and finishes the session', async () => {
      const { ledger, brain, r, delivered, finished, logs } = setup()
      ledger.recordSpawn('holder', null, 'bp-eml', 'claude', true, 'new')
      ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
      await r.turnEnded('s1', HANDOFF, { result: 'Design board done', questions: ['Which layout?'] })
      expect(ledger.get('s1')!.taskId).toBe('old')
      expect(delivered).toEqual([expect.objectContaining({ target: 'holder', text: expect.stringContaining('Hand-over from session') })])
      expect(delivered[0]!.text).toContain('Which layout?')
      expect(brain.journal('new')).toEqual([expect.stringMatching(/^Hand-over from session "s1" \(s1\), which worked on task old/)])
      expect(brain.journal('old')).toEqual([])
      expect(finished).toEqual(['s1'])
      expect(logs.some((l) => l.includes('held by holder') && l.includes('hand-over delivered'))).toBe(true)
    })

    it('delivers and writes a hand-over once when the turn is routed again after a restart', async () => {
      const { ledger, brain, restarted, delivered, finished } = setup()
      ledger.recordSpawn('holder', null, 'bp-eml', 'claude', true, 'new')
      ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
      await restarted().turnEnded('s1', HANDOFF)
      await restarted().turnEnded('s1', HANDOFF)
      expect(delivered).toHaveLength(1)
      expect(brain.journal('new')).toHaveLength(1)
      expect(finished).toEqual(['s1', 's1'])
    })

    it('leaves the turn unrouted when the brain does not answer: nothing is written and the session is not finished', async () => {
      const { ledger, brain, r, finished, logs } = setup()
      ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
      brain.down.add('new')
      await r.turnEnded('s1', HANDOFF)
      expect(brain.posts).toEqual([])
      expect(finished).toEqual([])
      expect(ledger.get('s1')!.taskId).toBe('old')
      expect(logs.some((l) => l.includes('[router] s1') && l.includes('failed'))).toBe(true)
      brain.down.clear()
      await r.turnEnded('s1', HANDOFF)
      expect(ledger.get('s1')!.taskId).toBe('new')
      expect(brain.journal('new')).toEqual([expect.stringMatching(/moved here/), HANDOFF])
    })

    it('writes the hand-over to the replacing task when a request starting on it holds it, and finishes the session', async () => {
      const { ledger, brain, r, delivered, finished } = setup({ pending: [{ id: 'q1', projectId: 'bp-eml', prompt: 'p', title: null, fromSessionId: null, taskId: 'new', createdAt: '2026-11-27T15:00:00Z', origin: 'runner' }] })
      ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
      await r.turnEnded('s1', HANDOFF)
      expect(delivered).toEqual([])
      expect(brain.journal('new')).toEqual([expect.stringContaining(HANDOFF)])
      expect(finished).toEqual(['s1'])
    })

    it('writes nothing for a turn that handed nothing over while another session holds the replacement', async () => {
      const { ledger, brain, r, delivered, finished, logs } = setup()
      ledger.recordSpawn('holder', null, 'bp-eml', 'claude', true, 'new')
      ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
      ledger.setAttention('s1', { kind: 'done', reason: 'Finished the board' })
      await r.turnEnded('s1', 'Finished.')
      expect(brain.posts).toEqual([])
      expect(delivered).toEqual([])
      expect(finished).toEqual(['s1'])
      expect(logs.some((l) => l.includes('nothing to hand over'))).toBe(true)
    })

    it('keeps the hand-over in the replacing task\'s journal when the holder cannot take it', async () => {
      const { ledger, brain, r, finished } = setup({ outcome: 'busy' })
      ledger.recordSpawn('holder', null, 'bp-eml', 'claude', true, 'new')
      ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
      await r.turnEnded('s1', HANDOFF)
      expect(brain.journal('new')).toEqual([expect.stringContaining(HANDOFF)])
      expect(finished).toEqual(['s1'])
    })

    it('moves the session after all when the holder\'s context is very long: the holder is put away and the turn is routed there', async () => {
      const { ledger, brain, r, putAway, delivered, finished } = setup({ contextTokens: 150_000 })
      ledger.recordSpawn('holder', null, 'bp-eml', 'claude', true, 'new')
      ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
      await r.turnEnded('s1', HANDOFF)
      expect(putAway).toEqual(['holder'])
      expect(delivered).toEqual([])
      expect(ledger.get('s1')!.taskId).toBe('new')
      expect(brain.journal('new')).toEqual([expect.stringMatching(/moved here/), HANDOFF])
      expect(finished).toEqual([])
    })

    it('routes a replaced task with no clear replacement as any closed task', async () => {
      const { ledger, brain, r, finished } = setup({ tasks: [{ id: 'old', status: 'superseded' }] })
      ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 'old')
      await r.turnEnded('s1', HANDOFF)
      expect(brain.posts).toEqual([])
      expect(finished).toEqual(['s1'])
    })
  })
})
