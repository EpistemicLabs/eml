import { describe, it, expect } from 'vitest'
import { withoutDelegate } from '../src/brain-mcp.js'

describe('delegate only where the task system is on', () => {
  const inner = () => {
    const posts: Array<{ path: string; body: unknown }> = []
    return { posts, api: { get: async () => ({}), post: async (path: string, body: unknown) => { posts.push({ path, body }); return { ok: true } }, put: async () => ({}) } }
  }

  it('refuses a delegate on a task an agent creates or tracks, and passes everything else', async () => {
    const { posts, api } = inner()
    const guarded = withoutDelegate(api as never)
    await expect(guarded.post('/engram/task', { title: 'x', delegate: 'atlas' })).rejects.toThrow(/the task system is off in this space/)
    await expect(guarded.post('/task/t1/track', { delegate: 'atlas', text: 'x' })).rejects.toThrow(/the task system is off in this space/)
    await guarded.post('/task/t1/track', { delegate: null, text: 'take it back' })
    await guarded.post('/task/t1/track', { text: 'progress' })
    await guarded.post('/engram/note', { content: 'n', delegate: 'not a task' })
    expect(posts.map((p) => p.path)).toEqual(['/task/t1/track', '/task/t1/track', '/engram/note'])
  })
})
