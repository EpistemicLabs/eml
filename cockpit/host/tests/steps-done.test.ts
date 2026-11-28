import { describe, it, expect } from 'vitest'
import { createStepsDone, stepsDoneWait } from '../src/application/steps-done.js'

const NOW = Date.parse('2026-11-28T10:00:00Z')
type T = { id: string; status: string; parent_id?: string | null; updated_at?: string; properties?: Record<string, unknown>; entries?: Array<{ kind: string; at: string; text: string }> }

function world(tasks: T[], opts: { working?: string[]; me?: string } = {}) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const fetched: string[] = []
  const brain = {
    async get(path: string, query?: Record<string, unknown>) {
      if (path === '/list') {
        const rows = tasks.filter((t) => t.status === query?.status)
        return { engrams: rows.map((t) => ({ id: t.id, status: t.status, parent_id: t.parent_id ?? null, updated_at: t.updated_at })) }
      }
      const id = decodeURIComponent(path.slice('/engram/'.length))
      fetched.push(id)
      return tasks.find((t) => t.id === id) ?? null
    },
    async post(path: string, body: Record<string, unknown>) {
      posts.push({ path, body })
      const t = tasks.find((x) => x.id === decodeURIComponent(/^\/task\/([^/]+)\/track$/.exec(path)![1]))!
      t.properties = { ...t.properties, waits: body.waits }
      t.entries = [...(t.entries ?? []), { kind: 'note', at: new Date(NOW).toISOString(), text: String(body.text) }]
      return t
    },
  }
  const done = createStepsDone({ me: opts.me ?? 'lasse', working: (id) => (opts.working ?? []).includes(id), now: () => NOW, log: () => {} })
  return { brain, posts, fetched, check: (shared = false) => done.check({ id: 'main', shared }, brain) }
}

const parent = (props: Record<string, unknown> = {}, entries: T['entries'] = []): T => ({ id: 'p', status: 'active', properties: { assignee_ids: ['lasse'], ...props }, entries })
const step = (id: string, status: string, updated_at = '2026-11-28T09:00:00.000Z'): T => ({ id, status, parent_id: 'p', updated_at })

describe('all steps done', () => {
  it('brings the main task back once, as a review for its owner, when its last step closed', async () => {
    const w = world([parent(), step('a', 'resolved', '2026-11-27T09:00:00.000Z'), step('b', 'invalidated')])
    await w.check()
    expect(w.posts).toEqual([{ path: '/task/p/track', body: {
      waits: [{ id: 'steps-done', who: 'lasse', kind: 'review', why: 'All steps done: looks good?', since: '2026-11-28T10:00:00.000Z' }],
      text: 'All steps done: its last step closed, so the task comes back to lasse for review.',
    } }])
    await w.check()
    expect(w.posts).toHaveLength(1)
    // A restart forgets what it settled; the journal says it was done.
    const again = world([parent({}, [{ kind: 'note', at: '2026-11-28T09:30:00.000Z', text: 'All steps done: its last step closed, so the task comes back to lasse for review.' }]), step('b', 'resolved')])
    await again.check()
    expect(again.posts).toEqual([])
  })

  it('folds a review held back during the steps into its one ask, and keeps the other waits', async () => {
    const held = { id: 's1', who: 'lasse', kind: 'review', why: 'Review: the new service runs.', since: '2026-11-27T08:00:00.000Z', session_id: 's1' }
    const kim = { id: 'kim', who: 'outside:Kim', kind: 'outside', why: 'invoice', since: '2026-11-27T08:00:00.000Z' }
    const w = world([parent({ waits: [held, kim] }), step('a', 'resolved')])
    await w.check()
    expect(w.posts[0].body.waits).toEqual([kim, { id: 'steps-done', who: 'lasse', kind: 'review', why: 'All steps done: the new service runs. Looks good?', since: '2026-11-28T10:00:00.000Z' }])
  })

  it('leaves a main task with an open step, a session working on it, a review asked since the close, another member\'s in a shared space, or an old close', async () => {
    const open = world([parent(), step('a', 'resolved'), step('b', 'active')])
    await open.check()
    const working = world([parent(), step('a', 'resolved')], { working: ['p'] })
    await working.check()
    const asked = world([parent({ waits: [{ id: 's1', who: 'lasse', kind: 'review', why: 'Review: x', since: '2026-11-28T09:30:00.000Z' }] }), step('a', 'resolved')])
    await asked.check()
    const theirs = world([parent({ assignee_ids: ['dominik'] }), step('a', 'resolved')])
    await theirs.check(true)
    const old = world([parent(), step('a', 'resolved', '2026-11-01T00:00:00.000Z')])
    await old.check()
    const closed = world([{ ...parent(), status: 'resolved' }, step('a', 'resolved')])
    await closed.check()
    for (const w of [open, working, asked, theirs, old, closed]) expect(w.posts).toEqual([])
    expect(open.fetched).toEqual([])
  })

  it('says the held review in its words, without its "Review:" prefix', () => {
    expect(stepsDoneWait('lasse', [], 'T').why).toBe('All steps done: looks good?')
  })
})
