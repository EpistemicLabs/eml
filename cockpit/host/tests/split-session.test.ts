import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSplitSession, SPLIT_UNDO_MS, type SessionFacts, type SplitInput } from '../src/application/split-session.js'
import { TaskCommandStore } from '../src/application/task-commands.js'

const noTask: SessionFacts = { spaceId: null, title: 'Session review', taskId: null }

function setup(opts: { session?: SessionFacts | null; failOnce?: string } = {}) {
  let failing = opts.failOnce
  const posts: Array<[string, Record<string, unknown>]> = []
  const spawned: Array<Record<string, unknown>> = []
  const ended: string[] = []
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
    changed: () => {},
    now: () => clock.now,
    log: () => {},
  })
  return { split, posts, spawned, ended, clock }
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
      ['/engram/task', { title: 'media-viewer', display_title: 'Media viewer', content: 'Media viewer\n\nGoal: open files in the cockpit.', scope: 'project.ui', status: 'active' }],
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
})
