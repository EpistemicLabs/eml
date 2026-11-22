import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSortSession } from '../src/application/sort-session.js'
import { TaskCommandStore } from '../src/application/task-commands.js'

function setup(opts: { taskSystem?: boolean; taskId?: string | null } = {}) {
  const posts: Array<[string, Record<string, unknown>]> = []
  let next = 0
  const sort = createSortSession({
    store: new TaskCommandStore(join(mkdtempSync(join(tmpdir(), 'sort-')), 'task-commands.json')),
    session: (id) => (id === 's1' ? { spaceId: null, title: 'Session review', taskId: opts.taskId === undefined ? 't-root' : opts.taskId, projectId: 'p-ui' } : null),
    space: () => ({ id: 'main' }) as never,
    taskSystem: () => opts.taskSystem ?? true,
    brain: () => ({
      get: async () => ({ title: 'session-review-ui', scope: 'project.ui' }),
      post: async (path: string, body: Record<string, unknown>) => { posts.push([path, body]); return path === '/engram/task' ? { id: `t-new-${++next}` } : {} },
    }) as never,
    changed: () => {},
    now: () => Date.parse('2026-11-22T10:00:00Z'),
    log: () => {},
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
    expect(posts[1][1]).toEqual({ title: 'media-viewer', content: 'Media viewer\n\nGoal: open files.', scope: 'project.ui', status: 'planned' })
    expect(posts[4][1]).toMatchObject({ status: 'invalidated', outcome: 'Dropped when its session was sorted' })
    expect(posts[5][1]).toEqual({ text: 'This session was sorted: 1 linked, 1 created, 1 closed.' })
  })

  it('does the work once for a retried operation', async () => {
    const { sort, posts } = setup()
    await sort.apply({ opId: 'op', sessionId: 's1', rows: [{ topic: 'Media viewer', pick: 'unrelated' }] })
    await sort.apply({ opId: 'op', sessionId: 's1', rows: [{ topic: 'Media viewer', pick: 'unrelated' }] })
    expect(posts.filter(([p]) => p === '/engram/task')).toHaveLength(1)
  })

  it('needs the task system and a task on the session', async () => {
    expect(await setup({ taskSystem: false }).sort.apply({ opId: 'a', sessionId: 's1', rows: [] })).toEqual({ ok: false, refusal: 'no_task' })
    expect(await setup({ taskId: null }).sort.apply({ opId: 'b', sessionId: 's1', rows: [] })).toEqual({ ok: false, refusal: 'no_task' })
    expect(await setup().sort.apply({ opId: 'c', sessionId: 'nope', rows: [] })).toEqual({ ok: false, refusal: 'unknown_session' })
  })
})
