import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-triage-'))
process.env.EML_COCKPIT_HOME = home

// Triage: a session's new standalone task waits in the cockpit until the user
// accepts, merges or closes it; the brain only sees approved tasks.

type Mod = typeof import('../src/application/triage.js')

function fakeBrain(open: Array<{ id: string; title: string; scope: string; status?: string }> = []) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  let next = 1
  return {
    posts,
    async get(path: string, query?: Record<string, unknown>) {
      if (path === '/list') {
        const words = String(query?.search ?? '').toLowerCase().split(' ')
        return { engrams: open.filter((t) => (t.status ?? 'active') === query?.status && t.scope === query?.scope && words.every((w) => t.title.toLowerCase().includes(w))).map((t) => ({ ...t, content: '', status: t.status ?? 'active' })) }
      }
      const id = path.slice('/engram/'.length)
      const t = open.find((o) => o.id === id)
      if (!t) throw new Error('not found')
      return { ...t, content: '', status: t.status ?? 'active' }
    },
    async post(path: string, body: Record<string, unknown>) {
      posts.push({ path, body })
      return path === '/engram/task' ? { id: `t${next++}`, ...body } : { id: 'x' }
    },
    async put() { return {} },
  }
}

describe('triage', () => {
  let mod: Mod
  beforeAll(async () => { mod = await import('../src/application/triage.js') })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const setup = (open: Parameters<typeof fakeBrain>[0] = [], file = join(home, `t-${Math.random()}.json`)) => {
    const store = new mod.TriageStore(file)
    const brain = fakeBrain(open)
    const moved: Array<[string, string | null]> = []
    const triage = mod.createTriage({ store, brain: () => brain, retarget: (from, to) => moved.push([from, to]), log: () => {} })
    const client = mod.triagedClient(brain as never, { triage, store, spaceId: 'main', sessionId: 's1', sessionName: () => 'Email Lord' })
    return { store, brain, triage, client, moved, file }
  }

  it('holds a session\'s new standalone task, suggests the open task it matches, and survives a restart', async () => {
    const { store, brain, client, file } = setup([{ id: 'lohmann-open', title: 'lohmann-custom-tracking-setup', scope: 'project.lohmann' }])
    const out = await client.post('/engram/task', { title: 'lohmann-custom-tracking', content: 'Answer the request', scope: 'project.lohmann' }) as Record<string, unknown>
    expect(mod.isPending(out.id)).toBe(true)
    expect(out.status).toBe('pending triage')
    expect(brain.posts).toEqual([])
    const item = store.pending()[0]
    expect(item).toMatchObject({ title: 'lohmann-custom-tracking', scope: 'project.lohmann', source: { kind: 'session', sessionId: 's1', sessionName: 'Email Lord' } })
    expect(item.suggestion).toEqual({ kind: 'merge', taskId: 'lohmann-open', title: 'lohmann-custom-tracking-setup' })
    expect(new mod.TriageStore(file).pending()).toHaveLength(1)
  })

  it('lets a step of a real task and a task the user asked for straight in, without the flag', async () => {
    const { store, brain, client } = setup()
    await client.post('/engram/task', { title: 'step', content: 'x', scope: 'global', parent_id: 'real-task' })
    await client.post('/engram/task', { title: 'asked', content: 'x', scope: 'global', approved_by_user: true })
    expect(brain.posts.map((p) => p.body)).toEqual([
      { title: 'step', content: 'x', scope: 'global', parent_id: 'real-task' },
      { title: 'asked', content: 'x', scope: 'global' },
    ])
    expect(store.pending()).toEqual([])
  })

  it('keeps progress on a pending task, refuses links to it, and writes all of it on accept', async () => {
    const { brain, client, triage, moved } = setup()
    const { id } = await client.post('/engram/task', { title: 'new-thing', content: 'Do it', scope: 'global' }) as { id: string }
    await client.post(`/task/${id}/track`, { text: 'started' })
    await expect(client.post('/engram/decision', { title: 'd', task_id: id })).rejects.toThrow()
    triage.keep(id, '### Handoff\nResult: half done', { who: 'lasse', why: 'go?' })
    expect(brain.posts).toEqual([])
    const done = await triage.accept(id, 'project.eml')
    expect(done).toMatchObject({ state: 'accepted', taskId: 't1' })
    expect(brain.posts[0]).toEqual({ path: '/engram/task', body: { title: 'new-thing', content: 'Do it', scope: 'project.eml' } })
    expect(brain.posts.slice(1).map((p) => p.body)).toEqual([{ text: 'started' }, { text: '### Handoff\nResult: half done' }, { waiting_on: { who: 'lasse', why: 'go?' } }])
    expect(moved).toEqual([[id, 't1']])
    // Afterwards the pending id stands for the real task.
    await client.post('/engram/decision', { title: 'd', task_id: id })
    expect(brain.posts.at(-1)!.body.task_id).toBe('t1')
  })

  it('merges into an open task, closes without a trace, and refuses to act twice', async () => {
    const { brain, client, triage, moved } = setup([{ id: 'open-1', title: 'existing', scope: 'global' }])
    const a = await client.post('/engram/task', { title: 'dup', content: 'Same thing', scope: 'global' }) as { id: string }
    await triage.merge(a.id, 'open-1')
    expect(brain.posts.map((p) => p.path)).toEqual(['/task/open-1/track'])
    expect(moved).toEqual([[a.id, 'open-1']])
    const b = await client.post('/engram/task', { title: 'noise', content: 'nothing', scope: 'global' }) as { id: string }
    expect(triage.close(b.id).state).toBe('closed')
    expect(moved.at(-1)).toEqual([b.id, null])
    expect(() => triage.close(b.id)).toThrow()
    await expect(client.post('/engram/decision', { task_id: b.id })).rejects.toThrow()
  })
})
