import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSortSession } from '../src/application/sort-session.js'
import { TaskCommandStore } from '../src/application/task-commands.js'

function setup(opts: { taskId?: string | null; failOnce?: string; source?: Record<string, unknown>; scheduled?: string[] } = {}) {
  let failing = opts.failOnce
  const posts: Array<[string, Record<string, unknown>]> = []
  let next = 0
  const sort = createSortSession({
    store: new TaskCommandStore(join(mkdtempSync(join(tmpdir(), 'sort-')), 'task-commands.json')),
    session: (id) => (id === 's1' ? { spaceId: null, title: 'Session review', taskId: opts.taskId === undefined ? 't-root' : opts.taskId } : null),
    space: () => ({ id: 'main' }) as never,
    brain: () => ({
      get: async (path: string) => ({ id: path.split('/').pop(), ...(opts.source ?? { title: 'session-review-ui', scope: 'project.ui' }) }),
      post: async (path: string, body: Record<string, unknown>) => { if (failing && path === failing) { failing = undefined; throw new Error('brain went away') } posts.push([path, body]); return path === '/engram/task' ? { id: `t-new-${++next}` } : {} },
    }) as never,
    changed: () => {},
    now: () => Date.parse('2026-11-22T10:00:00Z'),
    log: () => {},
    me: 'lasse',
    scheduled: (task) => (opts.scheduled ?? []).includes(task.id),
  })
  return { sort, posts }
}

describe('applying a sort', () => {
  it('links, creates and closes with a journal entry each, and sums it up on the session\'s task', async () => {
    const { sort, posts } = setup()
    const answer = await sort.apply({ opId: 'op', sessionId: 's1', rows: [
      { topic: 'Task board mockup', pick: 'sub', taskId: 't-board' },
      { topic: 'Media viewer', pick: 'spun', brief: 'Goal: open files.' },
      { topic: 'Top bar v2', pick: 'drop', taskId: 't-top' },
    ] })
    expect(answer.ok && answer.command.sort).toEqual({ linked: 1, created: 1, closed: 1 })
    expect(posts.map(([p]) => p)).toEqual(['/task/t-board/track', '/engram/task', '/relate', '/task/t-new-1/track', '/task/t-top/track', '/task/t-root/track'])
    expect(posts[0][1]).toMatchObject({ parent_id: 't-root' })
    expect(posts[1][1]).toEqual({ title: 'media-viewer', display_title: 'Media viewer', content: 'Media viewer\n\nGoal: open files.', scope: 'project.ui', assignee_ids: ['lasse'], status: 'planned' })
    expect(posts[4][1]).toMatchObject({ status: 'invalidated', outcome: 'Dropped when its session was sorted' })
    expect(posts[5][1]).toEqual({ text: 'This session was sorted: 1 linked, 1 created, 1 closed.' })
  })

  it('does not drop a task whose schedule is still on: it stays open, its journal and the summary say so', async () => {
    const { sort, posts } = setup({ scheduled: ['t-daily'] })
    const answer = await sort.apply({ opId: 'op', sessionId: 's1', rows: [
      { topic: 'Daily brief', pick: 'drop', taskId: 't-daily' },
      { topic: 'Top bar v2', pick: 'drop', taskId: 't-top' },
    ] })
    expect(answer.ok && answer.command.sort).toEqual({ linked: 0, created: 0, closed: 1, kept: 1 })
    expect(posts).toEqual([
      ['/task/t-daily/track', { text: 'Not dropped when the session "Session review" (task session-review-ui) was sorted: its schedule is still on. End schedule and close on the task board closes it.' }],
      ['/task/t-top/track', expect.objectContaining({ status: 'invalidated' })],
      ['/task/t-root/track', { text: 'This session was sorted: 0 linked, 0 created, 1 closed, 1 kept open (schedule still on).' }],
    ])
  })

  it('a retry after a failure part-way resumes without repeating a step', async () => {
    const { sort, posts } = setup({ failOnce: '/task/t-top/track' })
    const rows = [
      { topic: 'Media viewer', pick: 'spun' as const },
      { topic: 'Top bar v2', pick: 'drop' as const, taskId: 't-top' },
    ]
    await expect(sort.apply({ opId: 'op', sessionId: 's1', rows })).rejects.toThrow('brain went away')
    const answer = await sort.apply({ opId: 'op', sessionId: 's1', rows })
    expect(answer.ok && answer.command.sort).toEqual({ linked: 0, created: 1, closed: 1 })
    expect(posts.map(([p]) => p)).toEqual(['/engram/task', '/relate', '/task/t-new-1/track', '/task/t-top/track', '/task/t-root/track'])
  })

  it('does the work once for a retried operation', async () => {
    const { sort, posts } = setup()
    await sort.apply({ opId: 'op', sessionId: 's1', rows: [{ topic: 'Media viewer', pick: 'unrelated' }] })
    await sort.apply({ opId: 'op', sessionId: 's1', rows: [{ topic: 'Media viewer', pick: 'unrelated' }] })
    expect(posts.filter(([p]) => p === '/engram/task')).toHaveLength(1)
  })

  it('new tasks take the owners of the session\'s task; one outside every project makes none', async () => {
    const owned = setup({ source: { title: 'x', scope: 'project.ui', properties: { assignee_ids: ['dominik'] } } })
    await owned.sort.apply({ opId: 'o', sessionId: 's1', rows: [{ topic: 'Media viewer', pick: 'unrelated' }] })
    expect(owned.posts.find(([p]) => p === '/engram/task')![1].assignee_ids).toEqual(['dominik'])
    const global = setup({ source: { title: 'x', scope: 'global' } })
    expect(await global.sort.apply({ opId: 'g', sessionId: 's1', rows: [{ topic: 'Media viewer', pick: 'unrelated' }] })).toEqual({ ok: false, refusal: 'no_project' })
    expect(global.posts).toHaveLength(0)
    // linking and closing need no project
    expect((await global.sort.apply({ opId: 'l', sessionId: 's1', rows: [{ topic: 'Board', pick: 'sub', taskId: 't-board' }] })).ok).toBe(true)
  })

  it('needs a task on the session', async () => {
    expect(await setup({ taskId: null }).sort.apply({ opId: 'b', sessionId: 's1', rows: [] })).toEqual({ ok: false, refusal: 'no_task' })
    expect(await setup().sort.apply({ opId: 'c', sessionId: 'nope', rows: [] })).toEqual({ ok: false, refusal: 'unknown_session' })
  })
})
