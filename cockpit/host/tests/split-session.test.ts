import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSplitSession, SPLIT_UNDO_MS, type SessionFacts, type SplitInput } from '../src/application/split-session.js'
import { TaskCommandStore } from '../src/application/task-commands.js'
import type { DeliveryOutcome } from '../src/domain/session-delivery.js'

const noTask: SessionFacts = { spaceId: null, title: 'Session review', taskId: null }

type Holder = { sessionId: string; title: string } | { pending: string } | null

function setup(opts: { session?: SessionFacts | null; failOnce?: string; holder?: Holder; outcome?: DeliveryOutcome } = {}) {
  let failing = opts.failOnce
  const posts: Array<[string, Record<string, unknown>]> = []
  const spawned: Array<Record<string, unknown>> = []
  const ended: string[] = []
  const delivered: Array<[string, string]> = []
  const clock = { now: Date.parse('2026-11-22T10:00:00Z') }
  const space = { id: 'main', name: 'Main', shared: false }
  const brain = {
    async get(path: string) {
      if (path === '/engram/t-root') return { id: 't-root', title: 'session-review-ui', scope: 'project.ui', status: 'active' }
      if (path === '/engram/t-open') return { id: 't-open', title: 'fix-ended-mail-job', scope: 'project.ui', status: 'planned' }
      if (path === '/engram/t-closed') return { id: 't-closed', title: 'old', scope: 'project.ui', status: 'resolved' }
      return null
    },
    async post(path: string, body: Record<string, unknown>) {
      if (failing && path === failing) { failing = undefined; throw new Error('brain went away') }
      posts.push([path, body])
      return path === '/engram/task' ? { id: 't-new' } : {}
    },
  }
  const split = createSplitSession({
    store: new TaskCommandStore(join(mkdtempSync(join(tmpdir(), 'split-')), 'task-commands.json')),
    session: (id) => (id === 's1' ? (opts.session === undefined ? { spaceId: null, title: 'Session review', taskId: 't-root' } : opts.session) : null),
    space: () => space as never,
    brain: () => brain as never,
    brainProject: (_s, projectId) => (projectId === 'p-ui' ? 'ui' : projectId === 'p-folder' ? null : undefined),
    spawn: (input) => { spawned.push({ ...input, space: undefined }); return 's-new' },
    endSession: async (id) => { ended.push(id) },
    ...(opts.holder !== undefined ? {
      holderOf: () => opts.holder ?? null,
      deliver: async (id: string, text: string) => { delivered.push([id, text]); return opts.outcome ?? 'delivered' },
    } : {}),
    changed: () => {},
    now: () => clock.now,
    log: () => {},
    me: 'lasse',
  })
  return { split, posts, spawned, ended, delivered, clock }
}

const input = (patch: Partial<SplitInput> = {}): SplitInput => ({
  opId: 'op-1', sessionId: 's1', title: 'Media viewer', brief: 'Goal: open files in the cockpit.', relation: 'spun', when: 'now', projectId: 'p-ui', ...patch,
})

describe('splitting off from a session', () => {
  it('spun off now: makes the task, links its origin, journals both, and starts the session on it', async () => {
    const { split, posts, spawned } = setup()
    const answer = await split.submit(input())
    expect(answer.ok && answer.command).toMatchObject({ kind: 'split', state: 'applied', split: { createdTaskId: 't-new', spawnedSessionId: 's-new', sourceTaskId: 't-root' } })
    expect(posts).toEqual([
      ['/engram/task', { title: 'media-viewer', display_title: 'Media viewer', content: 'Media viewer\n\nGoal: open files in the cockpit.', scope: 'project.ui', assignee_ids: ['lasse'], status: 'active' }],
      ['/relate', { source_id: 't-new', target_id: 't-root', relation: 'derived_from', detection_method: 'manual', explanation: 'spun off from' }],
      ['/task/t-new/track', { text: 'Spun off from session-review-ui (session Session review).' }],
      ['/task/t-root/track', { text: 'Media viewer was spun off here as its own task.' }],
    ])
    expect(spawned).toEqual([expect.objectContaining({ fromSessionId: 's1', projectId: 'p-ui', title: 'Media viewer', taskId: 't-new' })])
    expect(String(spawned[0].prompt)).toContain('You get this brief, not that chat.')
  })

  it('puts a task split into a folder project where the session\'s task is', async () => {
    const { split, posts } = setup()
    await split.submit(input({ projectId: 'p-folder' }))
    expect(posts[0][1]).toMatchObject({ scope: 'project.ui' })
  })

  it('refuses a new task with no project to go into: a folder project and a session without a task', async () => {
    const { split, posts } = setup({ session: noTask })
    expect(await split.submit(input({ projectId: 'p-folder', when: 'park', relation: 'unrelated' }))).toEqual({ ok: false, refusal: 'no_project' })
    expect(posts).toHaveLength(0)
  })

  it('does the work once for a retried operation', async () => {
    const { split, posts } = setup()
    await split.submit(input())
    await split.submit(input())
    expect(posts.filter(([p]) => p === '/engram/task')).toHaveLength(1)
  })

  it('a retry after a failure part-way does each step once, and resumes where it stopped', async () => {
    const { split, posts, spawned } = setup({ failOnce: '/task/t-root/track' })
    await expect(split.submit(input())).rejects.toThrow('brain went away')
    expect(spawned).toEqual([])
    const answer = await split.submit(input())
    expect(answer.ok && answer.command).toMatchObject({ state: 'applied', split: { createdTaskId: 't-new', spawnedSessionId: 's-new' } })
    expect(posts.map(([p]) => p)).toEqual(['/engram/task', '/relate', '/task/t-new/track', '/task/t-root/track'])
    expect(spawned).toHaveLength(1)
  })

  it('refuses a second request with the same operation while the first still runs', async () => {
    const { split } = setup()
    const [first, second] = await Promise.all([split.submit(input()), split.submit(input())])
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, refusal: 'in_flight' })
  })

  it('from a session without a task, starting now writes nothing to the brain', async () => {
    const { split, posts, spawned } = setup({ session: noTask })
    const answer = await split.submit(input())
    expect(answer.ok && answer.command.split).toMatchObject({ createdTaskId: null, spawnedSessionId: 's-new', sourceTaskId: null })
    expect(posts).toEqual([])
    expect(spawned[0].taskId).toBeNull()
  })

  it('refuses an unknown session or project, and a sub-task without a task', async () => {
    expect(await setup().split.submit(input({ sessionId: 'nope' }))).toEqual({ ok: false, refusal: 'unknown_session' })
    expect(await setup().split.submit(input({ projectId: 'p-other' }))).toEqual({ ok: false, refusal: 'unknown_project' })
    expect(await setup({ session: noTask }).split.submit(input({ relation: 'sub' }))).toEqual({ ok: false, refusal: 'sub_needs_task' })
  })

  it('undo ends the new session and drops the task, within its window', async () => {
    const { split, posts, ended, clock } = setup()
    await split.submit(input())
    expect(split.owns('op-1')).toBe(true)
    const undone = await split.undo('op-1')
    expect(undone.ok && undone.command.state).toBe('undone')
    expect(ended).toEqual(['s-new'])
    expect(posts.slice(-2)).toEqual([
      ['/task/t-new/track', { status: 'invalidated', outcome: 'Split undone', text: 'The split was undone in the chat it came from.' }],
      ['/task/t-root/track', { text: 'The split of Media viewer was undone.' }],
    ])
    await split.submit(input({ opId: 'op-2' }))
    clock.now += SPLIT_UNDO_MS + 1
    expect(await split.undo('op-2')).toEqual({ ok: false, refusal: 'undo_expired' })
  })

  it('splits onto an existing open task: a session on it, nothing new made, and Undo leaves the task alone', async () => {
    const { split, posts, spawned, ended } = setup()
    const answer = await split.submit(input({ existingTaskId: 't-open' }))
    expect(answer.ok && answer.command.split).toMatchObject({ createdTaskId: null, existingTaskId: 't-open', spawnedSessionId: 's-new' })
    expect(posts.map(([p]) => p)).toEqual(['/task/t-open/track', '/task/t-root/track'])
    expect(spawned[0]).toMatchObject({ taskId: 't-open' })
    await split.undo('op-1')
    expect(ended).toEqual(['s-new'])
    expect(posts.some(([p, b]) => p === '/task/t-open/track' && b.status === 'invalidated')).toBe(false)
  })

  it('refuses an existing task that is closed or unknown', async () => {
    expect(await setup().split.submit(input({ existingTaskId: 't-closed' }))).toEqual({ ok: false, refusal: 'unknown_task' })
    expect(await setup().split.submit(input({ existingTaskId: 'nope' }))).toEqual({ ok: false, refusal: 'unknown_task' })
  })

  it('onto an existing task that has its session: the brief goes there, no session starts, and Undo leaves it running', async () => {
    const { split, spawned, delivered, ended } = setup({ holder: { sessionId: 's-task', title: 'Mail job' } })
    const answer = await split.submit(input({ existingTaskId: 't-open' }))
    expect(answer.ok && answer.command.split).toMatchObject({ existingTaskId: 't-open', spawnedSessionId: 's-task', routed: true })
    expect(spawned).toEqual([])
    expect(delivered.map(([id]) => id)).toEqual(['s-task'])
    expect(delivered[0][1]).toContain('Goal: open files in the cockpit.')
    await split.undo('op-1')
    expect(ended).toEqual([])
  })

  it('onto an existing task whose session cannot take the brief: refused, naming it, with nothing written; a retry helps only while it is busy', async () => {
    for (const [outcome, retry] of [['busy', true], ['running', true], ['refused', false], ['unknown', false]] as const) {
      const held = setup({ holder: { sessionId: 's-task', title: 'Mail job' }, outcome })
      const answer = await held.split.submit(input({ existingTaskId: 't-open' }))
      expect(answer).toMatchObject({ ok: false, refusal: 'task_held', retry })
      expect(!answer.ok && answer.message).toContain('Mail job')
      expect(held.posts).toEqual([])
      expect(held.spawned).toEqual([])
      // Nothing recorded either: a retry with the same operation starts over and tries the session again.
      await held.split.submit(input({ existingTaskId: 't-open' }))
      expect(held.delivered).toHaveLength(2)
    }
  })

  it('onto an existing task with a session still starting, or that this session holds itself: refused before anything is written', async () => {
    const starting = setup({ holder: { pending: 'req-1' } })
    const answer = await starting.split.submit(input({ existingTaskId: 't-open' }))
    expect(answer).toMatchObject({ ok: false, refusal: 'task_starting', retry: true })
    expect(!answer.ok && answer.message).toContain('req-1')
    expect(starting.posts).toEqual([])
    expect(starting.spawned).toEqual([])
    const mine = setup({ holder: { sessionId: 's1', title: 'Session review' } })
    expect(await mine.split.submit(input({ existingTaskId: 't-open' }))).toMatchObject({ ok: false, refusal: 'task_held_by_you', retry: false })
    expect(mine.posts).toEqual([])
    expect(mine.delivered).toEqual([])
  })

  it('onto an existing task nobody holds, or into a new task: a session starts on it', async () => {
    const free = setup({ holder: null })
    await free.split.submit(input({ existingTaskId: 't-open' }))
    expect(free.spawned).toHaveLength(1)
    const fresh = setup({ holder: { sessionId: 's-task', title: 'Mail job' } })
    await fresh.split.submit(input())
    expect(fresh.spawned).toHaveLength(1)
    expect(fresh.delivered).toEqual([])
  })
})
