import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-task-router-'))
process.env.EML_COCKPIT_HOME = home

type Router = typeof import('../src/application/task-router.js')
type HandoffMod = typeof import('../src/domain/handoff.js')
type Ledger = typeof import('../src/session-ledger.js')['SessionLedger']

const HANDOFF = `Done, the page is built.

### Handoff
Result: Homepage v4b hero built on the canvas.
Checked: copy rules R1–R10 · Claimed: the prices from the brief
Decided: kept the old CTA
Next: review by Lasse
Questions:
- [lasse] Ship the shorter headline?
- [task] Do we need a German variant?`

const require = createRequire(import.meta.url)
const { mostUrgentWait } = require('@engramprotocol/core') as { mostUrgentWait: (w: Array<Record<string, string>>) => Record<string, string> | undefined }

type Props = Record<string, unknown>

/**
 * A brain with one task that mirrors waits like core (task-state.ts): a waits
 * write sets waiting_on to the most urgent entry, a waiting_on write replaces
 * waits with that one wait. Every write moves rev; a stale base_rev is a 409.
 */
function fakeBrain(task: Record<string, unknown>) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  task.rev = 1
  const brain = {
    posts, task,
    /** Runs once before the next write lands, as another writer would. */
    before: null as null | (() => void),
    async get() { return structuredClone(task) },
    async post(path: string, body: Record<string, unknown>) {
      brain.before?.(); brain.before = null
      if (typeof body.base_rev === 'number' && body.base_rev !== task.rev) {
        throw Object.assign(new Error(`engram changed since rev ${body.base_rev as number}`), { status: 409 })
      }
      const { base_rev: _rev, ...rest } = body
      posts.push({ path, body: rest })
      write(rest)
      return task
    },
  }
  const write = (body: Props) => {
    const props = { ...(task.properties as Props) }
    if ('waits' in body) {
      const waits = (body.waits ?? []) as Array<Record<string, string>>
      if (waits.length) props.waits = waits; else delete props.waits
      const top = mostUrgentWait(waits)
      if (top) { const { id: _id, ...flat } = top; props.waiting_on = flat } else delete props.waiting_on
    } else if ('waiting_on' in body) {
      const w = body.waiting_on as Record<string, string> | null
      if (w) { props.waiting_on = w; props.waits = [{ id: w.session_id ?? 'waiting_on', ...w }] } else { delete props.waiting_on; delete props.waits }
    }
    task.properties = props
    task.rev = (task.rev as number) + 1
  }
  return Object.assign(brain, { write })
}

const waitsOfTask = (brain: ReturnType<typeof fakeBrain>) => ((brain.task.properties as Props).waits ?? []) as Array<Record<string, string>>

describe('handoff', () => {
  let mod: HandoffMod
  beforeAll(async () => { mod = await import('../src/domain/handoff.js') })

  it('reads the last handoff block of a message', () => {
    const h = mod.parseHandoff(`### Handoff\nResult: old\n\n${HANDOFF}`)!
    expect(h.result).toBe('Homepage v4b hero built on the canvas.')
    expect(h.next).toBe('review by Lasse')
    expect(h.forUser).toEqual(['Ship the shorter headline?'])
    expect(h.forTask).toEqual(['Do we need a German variant?'])
    expect(h.text.startsWith('### Handoff\nResult: Homepage')).toBe(true)
  })

  it('reads a block in a code fence, with bold labels, untagged and empty questions', () => {
    const h = mod.parseHandoff('Text\n```\n## Handoff\n**Result:** ok\nQuestions:\n1. Which colour?\n- none\n```\nAfter the fence')!
    expect(h.result).toBe('ok')
    expect(h.forUser).toEqual(['Which colour?'])
    expect(h.text).not.toContain('After the fence')
    expect(mod.parseHandoff('### Handoff\nResult: done\nQuestions: none')!.forUser).toEqual([])
  })

  it('finds none in a message without the heading', () => {
    expect(mod.parseHandoff('Result: done, no block here')).toBeNull()
  })
})

describe('task router', () => {
  let router: Router
  let SessionLedger: Ledger
  beforeAll(async () => {
    router = await import('../src/application/task-router.js')
    SessionLedger = (await import('../src/session-ledger.js')).SessionLedger
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const setup = (task: Record<string, unknown>, space: { shared: boolean; agent?: string } = { shared: false }, handles: string[] = []) => {
    const ledger = new SessionLedger()
    const brain = fakeBrain(task)
    const logs: string[] = []
    const r = router.createTaskRouter({
      ledger, spaces: { resolve: () => space as never }, brain: () => brain, owner: 'lasse', handles: async () => handles,
      log: (l) => logs.push(l), now: () => new Date('2026-11-17T09:00:00Z'),
    })
    return { ledger, brain, r, logs }
  }

  it('puts the task on the user for a [lasse] question and writes the handoff once; the session itself is not marked as waiting', async () => {
    const { ledger, brain, r } = setup({ id: 't1', status: 'active', properties: {} })
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', false, 't1')
    await r.turnEnded('s1', HANDOFF)
    await r.turnEnded('s1', HANDOFF)
    expect(brain.posts).toHaveLength(1)
    expect(brain.posts[0].path).toBe('/task/t1/track')
    expect(brain.posts[0].body.text).toContain('Result: Homepage v4b hero')
    expect(brain.posts[0].body.waits).toEqual([{ id: 's1', who: 'lasse', kind: 'question', why: 'Ship the shorter headline?', since: '2026-11-17T09:00:00.000Z', session_id: 's1' }])
    expect(brain.task.properties).toMatchObject({ waiting_on: { who: 'lasse', kind: 'question', session_id: 's1' } })
    expect(ledger.get('s1')!.attention).toBeFalsy()
  })

  it('does not read the chat\'s flag on a worker that said nothing as a review hand-over, but a status it gave still is one', async () => {
    const silent = setup({ id: 't1', status: 'active', properties: { checkpoint: 'after', delegate: 'atlas' } })
    silent.ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 't1')
    // attentionAfterTurn: the worker stopped without a call, a handoff or a status.
    silent.ledger.setAttention('s1', { kind: 'review', reason: null })
    await silent.r.turnEnded('s1', 'OK', null, { unsaid: true })
    expect(silent.brain.posts).toHaveLength(0)

    const failed = setup({ id: 't1', status: 'active', properties: {} })
    failed.ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 't1')
    failed.ledger.setAttention('s1', { kind: 'failed', reason: null })
    await failed.r.turnEnded('s1', '', null, { unsaid: true })
    expect(waitsOfTask(failed.brain)).toMatchObject([{ who: 'lasse', kind: 'stopped' }])

    const told = setup({ id: 't1', status: 'active', properties: {} })
    told.ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, 't1')
    told.ledger.setAttention('s1', { kind: 'review', reason: 'Report' })
    await told.r.turnEnded('s1', 'Done.', null, { unsaid: false })
    expect(waitsOfTask(told.brain)).toMatchObject([{ who: 'lasse', kind: 'review', why: 'Review: Report' }])
  })

  describe('from an end_turn call', () => {
    const SPACE = { shared: true, agent: 'atlas' }
    const HANDLES = ['lasse', 'dominik', 'atlas', 'motti']
    const called = (properties: Props = {}) => {
      const made = setup({ id: 't-c', status: 'active', properties }, SPACE, HANDLES)
      made.ledger.recordSpawn('s-c', null, 'bp-eml', 'claude', true, 't-c')
      return made
    }
    const wait = (w: Props) => ({ id: 's-c', since: '2026-11-17T09:00:00.000Z', session_id: 's-c', ...w })

    it.each<[string, Record<string, unknown>, Props, Props | null]>([
      ['a question waits on the owner', { result: 'Draft ready', questions: ['Send it today? It is long.', 'To whom?'] }, {}, { who: 'lasse', kind: 'question', why: 'Send it today? · To whom?' }],
      ['a question of a step with checkpoint before is a go', { result: 'Plan ready', questions: ['Start?'] }, { checkpoint: 'before' }, { who: 'lasse', kind: 'go', why: 'Start?' }],
      ['the owner next is a review', { result: 'Draft ready', next: { who: 'lasse', what: 'read the draft' } }, {}, { who: 'lasse', kind: 'review', why: 'read the draft' }],
      ['another member next waits on them', { result: 'Draft ready', next: { who: '@Dominik', what: 'sign it' } }, {}, { who: 'dominik', kind: 'review', why: 'sign it' }],
      ['another agent next waits on it', { result: 'Draft ready', next: { who: 'motti', what: 'translate it' } }, {}, { who: 'motti', kind: 'review', why: 'translate it' }],
      ['someone outside next is an outside wait', { result: 'Mail sent', next: { who: 'outside:Acme support', what: 'answer the mail', when: '2026-11-27T10:00' } }, {}, { who: 'Acme support', kind: 'outside', why: 'answer the mail' }],
      ['an unknown handle is someone outside', { result: 'Mail sent', next: { who: 'kim', what: 'answer' } }, {}, { who: 'kim', kind: 'outside', why: 'answer' }],
      ['a failure stops on the owner', { result: 'Stuck', failed: 'No access to the shop', next: { who: 'dominik', what: 'x' } }, {}, { who: 'lasse', kind: 'stopped', why: 'No access to the shop' }],
      ['its own next step at a time waits on nobody', { result: 'Mail sent', next: { who: 'atlas', what: 'look again', when: '2026-11-27T10:00' } }, {}, null],
      ['nothing next waits on nobody', { result: 'All done' }, { checkpoint: 'after' }, null],
    ])('%s', async (_row, call, properties, expected) => {
      const { brain, r } = called(properties)
      await r.turnEnded('s-c', 'The reply, without a block.', call as never)
      expect(waitsOfTask(brain)).toEqual(expected ? [wait(expected)] : [])
    })

    it('writes the call into the journal as its block, once, and takes the call over a block in the reply', async () => {
      const { brain, r } = called()
      const call = { result: 'Mail sent to Acme', checked: 'the address', decided: 'no reminder', next: { who: 'me', what: 'look for the answer', when: '2026-11-27T10:00' } }
      await r.turnEnded('s-c', HANDOFF, call)
      await r.turnEnded('s-c', HANDOFF, call)
      expect(brain.posts).toEqual([{ path: '/task/t-c/track', body: {
        text: '### Handoff\nResult: Mail sent to Acme\nChecked: the address\nDecided: no reminder\nNext: [atlas] look for the answer @ 2026-11-27T10:00',
      } }])
    })

    it('a call replaces the wait of the session\'s last call and keeps another session\'s', async () => {
      const { ledger, brain, r } = called({ waits: [{ id: 's-o', who: 'lasse', kind: 'review', why: 'Review: x', since: '2026-11-17T08:00:00.000Z', session_id: 's-o' }] })
      ledger.recordSpawn('s-o', null, 'bp-eml', 'claude', false, 't-c')
      await r.turnEnded('s-c', '', { result: 'Draft ready', next: { who: 'dominik', what: 'sign it' } })
      await r.turnEnded('s-c', '', { result: 'Signed', next: { who: 'outside:Acme', what: 'countersign' } })
      expect(waitsOfTask(brain).map((w) => [w.id, w.who, w.kind])).toEqual([['s-o', 'lasse', 'review'], ['s-c', 'Acme', 'outside']])
      await r.turnEnded('s-c', '', { result: 'Countersigned, nothing left' })
      expect(waitsOfTask(brain).map((w) => w.id)).toEqual(['s-o'])
    })

    it('a later turn without a call leaves the call\'s wait: the status the call left is not routed on its own', async () => {
      const { ledger, brain, r } = called()
      // What the chat does with a call: the session's attention is the call's status.
      ledger.setAttention('s-c', { kind: 'done', reason: 'Draft ready' })
      await r.turnEnded('s-c', '', { result: 'Draft ready', next: { who: 'dominik', what: 'sign it' } })
      await r.turnEnded('s-c', 'Still waiting.')
      expect(brain.posts).toHaveLength(1)
      expect(waitsOfTask(brain)).toEqual([wait({ who: 'dominik', kind: 'review', why: 'sign it' })])
      // An answer ends it, and the same call again is routed anew.
      await r.answered('s-c')
      await r.turnEnded('s-c', '', { result: 'Draft ready', next: { who: 'dominik', what: 'sign it' } })
      expect(waitsOfTask(brain)).toHaveLength(1)
    })

    it('finishes a session whose call closes a closed task, and keeps one that asks', async () => {
      const done: string[] = []
      const finished = (call: Record<string, unknown>) => {
        const ledger = new SessionLedger()
        ledger.recordSpawn('s-f', null, 'bp-eml', 'claude', true, 't-f')
        const r = router.createTaskRouter({ ledger, spaces: { resolve: () => SPACE as never }, brain: () => fakeBrain({ id: 't-f', status: 'resolved', properties: {} }), owner: 'lasse', finished: (id) => done.push(id), log: () => {} })
        return r.turnEnded('s-f', '', call as never)
      }
      await finished({ result: 'Closed it', questions: ['Also the other one?'] })
      expect(done).toEqual([])
      await finished({ result: 'Closed it' })
      expect(done).toEqual(['s-f'])
    })
  })

  describe('from a block that names who is next', () => {
    it.each<[string, string, Props | null]>([
      ['a member', 'Next: [dominik] sign it', { who: 'dominik', kind: 'review', why: 'sign it' }],
      ['someone outside', 'Next: [outside:Acme] countersign @ 2026-11-27T10:00', { who: 'Acme', kind: 'outside', why: 'countersign' }],
      ['the owner', 'Next: [lasse] read it', { who: 'lasse', kind: 'review', why: 'read it' }],
      ['the agent itself', 'Next: [atlas] look again @ 2026-11-27T10:00', null],
      ['nobody', 'Next: review by Lasse', null],
    ])('%s', async (_who, next, expected) => {
      const { ledger, brain, r } = setup({ id: 't-b', status: 'active', properties: {} }, { shared: true, agent: 'atlas' }, ['lasse', 'dominik', 'atlas'])
      ledger.recordSpawn('s-b', null, 'bp-eml', 'claude', false, 't-b')
      const block = `### Handoff\nResult: Draft ready\n${next}`
      await r.turnEnded('s-b', `Done.\n\n${block}`)
      // The journal keeps the block as the session wrote it.
      expect(brain.posts[0].body.text).toBe(block)
      expect(waitsOfTask(brain)).toEqual(expected ? [{ id: 's-b', since: '2026-11-17T09:00:00.000Z', session_id: 's-b', ...expected }] : [])
    })

    it('a Failed line stops on the owner', async () => {
      const { ledger, brain, r } = setup({ id: 't-b', status: 'active', properties: {} })
      ledger.recordSpawn('s-b', null, 'bp-eml', 'claude', false, 't-b')
      await r.turnEnded('s-b', '### Handoff\nResult: Stuck\nFailed: No access to the shop')
      expect(waitsOfTask(brain)).toEqual([expect.objectContaining({ who: 'lasse', kind: 'stopped', why: 'No access to the shop' })])
    })
  })

  describe('decideWaiting', () => {
    const base = { handoff: null, attention: null, checkpoint: undefined, owner: 'lasse', sessionId: 's1', now: new Date('2026-11-17T09:00:00Z') }

    it('reads a call against the handles it is given, and an unknown one as outside', () => {
      const call = { result: 'x', next: { who: 'dominik', what: 'sign' } }
      expect(router.decideWaiting({ ...base, call, members: ['dominik'] })).toMatchObject({ who: 'dominik', kind: 'review' })
      expect(router.decideWaiting({ ...base, call })).toMatchObject({ who: 'dominik', kind: 'outside' })
    })

    it('a call without a wait wins over the status and the checkpoint', () => {
      expect(router.decideWaiting({ ...base, call: { result: 'x' }, attention: { kind: 'review', reason: 'old' }, checkpoint: 'after' })).toBeNull()
    })

    it('without a call or a block, the status decides as before', () => {
      expect(router.decideWaiting({ ...base, attention: { kind: 'question', reason: 'A or B?' } })).toMatchObject({ who: 'lasse', kind: 'question', why: 'A or B?' })
      expect(router.decideWaiting({ ...base, attention: { kind: 'failed', reason: null } })).toMatchObject({ kind: 'stopped', why: 'The session failed' })
      expect(router.decideWaiting({ ...base, attention: { kind: 'review', reason: 'Report' } })).toMatchObject({ kind: 'review', why: 'Review: Report' })
      expect(router.decideWaiting({ ...base, attention: { kind: 'done', reason: 'ok' } })).toBeNull()
    })
  })

  it('writes with the rev it read, and redoes the change once when another write came in between', async () => {
    const { ledger, brain, r } = setup({ id: 't-rev', status: 'active', properties: {} })
    ledger.recordSpawn('s-a', null, 'bp-eml', 'claude', false, 't-rev')
    brain.before = () => brain.write({ waits: [{ id: 's-other', who: 'lasse', kind: 'review', why: 'Review: x', since: '2026-11-17T08:00:00.000Z', session_id: 's-other' }] })
    await r.turnEnded('s-a', HANDOFF)
    expect(waitsOfTask(brain).map((w) => w.id)).toEqual(['s-other', 's-a'])
  })

  it('removes its own wait when the next handoff has no question, and leaves another session\'s', async () => {
    const { ledger, brain, r } = setup({ id: 't2', status: 'active', properties: { waiting_on: { who: 'lasse', why: 'old', since: 'x', session_id: 's2' } } })
    ledger.recordSpawn('s2', null, 'bp-eml', 'claude', false, 't2')
    ledger.recordSpawn('s3', null, 'bp-eml', 'claude', false, 't2')
    await r.turnEnded('s3', '### Handoff\nResult: side work done')
    expect(brain.posts.at(-1)!.body).toEqual({ text: '### Handoff\nResult: side work done' })
    await r.turnEnded('s2', '### Handoff\nResult: answered and finished')
    expect(brain.posts.at(-1)!.body.waits).toBeNull()
    expect(brain.task.properties).not.toHaveProperty('waiting_on')
  })

  it('routes a failed session and a step with checkpoint after that handed over a result', async () => {
    const failed = setup({ id: 't3', status: 'active', properties: {} })
    failed.ledger.recordSpawn('s4', null, 'bp-eml', 'claude', true, 't3')
    failed.ledger.setAttention('s4', { kind: 'failed', reason: 'Build broke' })
    await failed.r.turnEnded('s4', 'No block')
    expect(failed.brain.posts[0].body).toEqual({ waits: [expect.objectContaining({ id: 's4', kind: 'stopped', why: 'Build broke' })] })

    const after = setup({ id: 't4', status: 'active', properties: { checkpoint: 'after' } })
    after.ledger.recordSpawn('s5', null, 'bp-eml', 'claude', false, 't4')
    await after.r.turnEnded('s5', '### Handoff\nResult: draft written')
    expect(waitsOfTask(after.brain)).toEqual([expect.objectContaining({ kind: 'review', why: 'Review: draft written' })])
  })

  it('a question from a step with checkpoint before is a go', async () => {
    const { ledger, brain, r } = setup({ id: 't-go', status: 'active', properties: { checkpoint: 'before' } })
    ledger.recordSpawn('s-go', null, 'bp-eml', 'claude', false, 't-go')
    await r.turnEnded('s-go', HANDOFF)
    expect(waitsOfTask(brain)).toEqual([expect.objectContaining({ kind: 'go', why: 'Ship the shorter headline?' })])
  })

  it('puts a task on review when its session said review, whatever the checkpoint', async () => {
    const { ledger, brain, r } = setup({ id: 't-rv', status: 'active', properties: {} })
    ledger.recordSpawn('s-rv', null, 'bp-eml', 'claude', true, 't-rv')
    ledger.setAttention('s-rv', { kind: 'review', reason: 'Kim withdrew the cancellation' })
    await r.turnEnded('s-rv', '### Handoff\nResult: Kim withdrew the cancellation')
    expect(waitsOfTask(brain)).toEqual([expect.objectContaining({ who: 'lasse', kind: 'review', why: 'Review: Kim withdrew the cancellation' })])
  })

  it('replaces its own wait by session id: a new question takes the old one\'s place, the same one again changes nothing', async () => {
    const { ledger, brain, r } = setup({ id: 't-rp', status: 'active', properties: {} })
    ledger.recordSpawn('s-p', null, 'bp-eml', 'claude', false, 't-rp')
    ledger.recordSpawn('s-q2', null, 'bp-eml', 'claude', false, 't-rp')
    await r.turnEnded('s-p', HANDOFF)
    await r.turnEnded('s-q2', HANDOFF.replace('Ship the shorter headline?', 'Use the blue variant?'))
    await r.turnEnded('s-p', HANDOFF.replace('Ship the shorter headline?', 'Or the longer one?'))
    expect(waitsOfTask(brain).map((w) => [w.id, w.why])).toEqual([['s-p', 'Or the longer one?'], ['s-q2', 'Use the blue variant?']])
    const posts = brain.posts.length
    // A new handoff text with the same question: the journal gets it, the waits stay.
    await r.turnEnded('s-p', `${HANDOFF.replace('Ship the shorter headline?', 'Or the longer one?')}\n- [task] one more`)
    expect(brain.posts).toHaveLength(posts + 1)
    expect(brain.posts.at(-1)!.body).not.toHaveProperty('waits')
  })

  it('ignores a status the session gave before the task was reopened; a newer one still routes', async () => {
    const reopened = (at: string) => [{ kind: 'change', at: '2026-11-01T00:00:00.000Z', text: 'status active → resolved' }, { kind: 'change', at, text: 'reopened (active)' }]
    const stale = setup({ id: 't-ro', status: 'active', properties: {}, entries: reopened(new Date(Date.now() + 60_000).toISOString()) })
    stale.ledger.recordSpawn('s-ro', null, 'bp-eml', 'claude', true, 't-ro')
    stale.ledger.setAttention('s-ro', { kind: 'review', reason: 'Old result' })
    await stale.r.turnEnded('s-ro', 'Reopened it, as asked.')
    expect(stale.brain.posts).toEqual([])
    // A handoff in this turn is new: it goes to the journal, but the old status puts no wait.
    await stale.r.turnEnded('s-ro', '### Handoff\nResult: reopened')
    expect(stale.brain.posts).toEqual([{ path: '/task/t-ro/track', body: { text: '### Handoff\nResult: reopened' } }])

    const fresh = setup({ id: 't-rn', status: 'active', properties: {}, entries: reopened('2026-11-02T00:00:00.000Z') })
    fresh.ledger.recordSpawn('s-rn', null, 'bp-eml', 'claude', true, 't-rn')
    fresh.ledger.setAttention('s-rn', { kind: 'review', reason: 'New result' })
    await fresh.r.turnEnded('s-rn', 'Done.')
    expect(fresh.brain.posts[0].body.waits).toEqual([expect.objectContaining({ kind: 'review', why: 'Review: New result' })])
  })

  it('leaves a quiet reschedule off the user: the handoff goes to the journal, nobody waits', async () => {
    const { ledger, brain, r } = setup({ id: 't-q', status: 'active', properties: {} })
    ledger.recordSpawn('s-q', null, 'bp-eml', 'claude', true, 't-q')
    ledger.setAttention('s-q', { kind: 'done', reason: 'No reply yet; next check tomorrow 10:00' })
    await r.turnEnded('s-q', '### Handoff\nResult: No reply from Kim yet.\nNext: check again tomorrow 10:00 (job)')
    expect(brain.posts[0].body).toEqual({ text: '### Handoff\nResult: No reply from Kim yet.\nNext: check again tomorrow 10:00 (job)' })
  })

  it('finishes a session that closed its task and asks nothing, and keeps one that still asks', async () => {
    const finished: string[] = []
    const ledger = new SessionLedger()
    const brain = fakeBrain({ id: 't9', status: 'resolved', properties: {} })
    const r = router.createTaskRouter({
      ledger, spaces: { resolve: () => ({ shared: false }) as never }, brain: () => brain, owner: 'lasse',
      finished: (id) => finished.push(id), log: () => {},
    })
    ledger.recordSpawn('s10', null, 'bp-eml', 'claude', true, 't9')
    ledger.recordSpawn('s11', null, 'bp-eml', 'claude', true, 't9')
    await r.turnEnded('s10', '### Handoff\nResult: step done')
    await r.turnEnded('s11', HANDOFF)
    expect(finished).toEqual(['s10'])
    expect(brain.posts).toHaveLength(0)
  })

  it('changes nothing without a handoff or status, or for a closed task, and routes in a shared space too', async () => {
    const plain = setup({ id: 't5', status: 'active', properties: {} })
    plain.ledger.recordSpawn('s6', null, 'bp-eml', 'claude', false, 't5')
    await plain.r.turnEnded('s6', 'Just chatting.')
    expect(plain.brain.posts).toHaveLength(0)

    const closed = setup({ id: 't6', status: 'resolved', properties: {} })
    closed.ledger.recordSpawn('s7', null, 'bp-eml', 'claude', false, 't6')
    await closed.r.turnEnded('s7', HANDOFF)
    expect(closed.brain.posts).toHaveLength(0)

    const shared = setup({ id: 't7', status: 'active', properties: {} }, { shared: true })
    shared.ledger.recordSpawn('s8', null, 'bp-eml', 'claude', false, 't7')
    await shared.r.turnEnded('s8', HANDOFF)
    expect(shared.brain.posts).toHaveLength(1)
  })

  it('keeps only the question, and removes a wait when the user answers the session that set it', async () => {
    const { ledger, brain, r } = setup({ id: 't20', status: 'active', properties: {} })
    ledger.recordSpawn('s20', null, 'bp-eml', 'claude', false, 't20')
    ledger.recordSpawn('s21', null, 'bp-eml', 'claude', false, 't20')
    await r.turnEnded('s20', HANDOFF)
    await r.answered('s21')
    expect(brain.posts).toHaveLength(1)
    await r.answered('s20')
    expect(brain.posts.at(-1)!.body).toEqual({ waits: null })
  })

  it('every session\'s question is on the task; when one is answered the next is waiting_on (B4)', async () => {
    const SECOND = HANDOFF.replace('Ship the shorter headline?', 'Use the blue variant?')
    const { ledger, brain, r, logs } = setup({ id: 't30', status: 'active', properties: {} })
    ledger.recordSpawn('s30', null, 'bp-eml', 'claude', false, 't30')
    ledger.recordSpawn('s31', null, 'bp-eml', 'claude', false, 't30')
    await r.turnEnded('s30', HANDOFF)
    await r.turnEnded('s31', SECOND)
    expect(waitsOfTask(brain).map((w) => w.id)).toEqual(['s30', 's31'])
    // Same kind: the older one is the most urgent.
    expect(brain.task.properties).toMatchObject({ waiting_on: { session_id: 's30', why: 'Ship the shorter headline?' } })
    expect(logs.at(-1)).toContain('waits behind s30')
    await r.answered('s30')
    expect(brain.task.properties).toMatchObject({ waiting_on: { session_id: 's31', why: 'Use the blue variant?' } })
    expect(logs.at(-1)).toContain("s31's wait up next")
    await r.answered('s31')
    expect(brain.task.properties).not.toHaveProperty('waiting_on')
    expect(brain.task.properties).not.toHaveProperty('waits')
  })

  it('a question is more urgent than a newer review: it blocks the agent (v0.23)', async () => {
    const { ledger, brain, r } = setup({ id: 't-urg', status: 'active', properties: {} })
    ledger.recordSpawn('s-u1', null, 'bp-eml', 'claude', false, 't-urg')
    ledger.recordSpawn('s-u2', null, 'bp-eml', 'claude', true, 't-urg')
    await r.turnEnded('s-u1', HANDOFF)
    ledger.setAttention('s-u2', { kind: 'review', reason: 'done' })
    await r.turnEnded('s-u2', '### Handoff\nResult: step done')
    expect(brain.task.properties).toMatchObject({ waiting_on: { session_id: 's-u1', kind: 'question' } })
  })

  it('a question comes up when the session before it moves on by itself; one put away drops out (B4)', async () => {
    const SECOND = HANDOFF.replace('Ship the shorter headline?', 'Use the blue variant?')
    const { ledger, brain, r } = setup({ id: 't31', status: 'active', properties: {} })
    ledger.recordSpawn('s32', null, 'bp-eml', 'claude', false, 't31')
    ledger.recordSpawn('s33', null, 'bp-eml', 'claude', false, 't31')
    ledger.recordSpawn('s34', null, 'bp-eml', 'claude', false, 't31')
    await r.turnEnded('s32', HANDOFF)
    await r.turnEnded('s33', SECOND)
    await r.turnEnded('s34', HANDOFF.replace('Ship the shorter headline?', 'Third?'))
    await r.turnEnded('s33', '### Handoff\nResult: settled it myself')
    await r.turnEnded('s32', '### Handoff\nResult: answered, going on')
    expect(brain.task.properties).toMatchObject({ waiting_on: { session_id: 's34', why: 'Third?' } })
    await r.answered('s34')
    await r.turnEnded('s32', HANDOFF.replace('Ship the shorter headline?', 'Again?'))
    await r.turnEnded('s33', SECOND.replace('blue', 'red'))
    // s33 is put away without answered() reaching the brain: the next write drops its wait.
    ledger.archive('s33')
    await r.answered('s32')
    expect(brain.task.properties).toMatchObject({ waiting_on: { session_id: 's33' } })
    await r.turnEnded('s34', HANDOFF.replace('Ship the shorter headline?', 'Fourth?'))
    expect(waitsOfTask(brain).map((w) => w.id)).toEqual(['s34'])
  })

  it('a wait answered on another member\'s machine lets the next one up here, without anything held on this host', async () => {
    const { ledger, brain, r } = setup({ id: 't-mm', status: 'active', properties: {} }, { shared: true })
    ledger.recordSpawn('s-here', null, 'bp-eml', 'claude', false, 't-mm')
    // Dominik's session (not in this ledger) asked first.
    brain.write({ waits: [{ id: 's-there', who: 'lasse', kind: 'question', why: 'Theirs?', since: '2026-11-17T08:00:00.000Z', session_id: 's-there' }] })
    await r.turnEnded('s-here', HANDOFF)
    expect(brain.task.properties).toMatchObject({ waiting_on: { session_id: 's-there' } })
    // Answered over there: their host removes their wait, as a replicated write.
    brain.write({ waits: waitsOfTask(brain).filter((w) => w.id !== 's-there') })
    expect(brain.task.properties).toMatchObject({ waiting_on: { session_id: 's-here', why: 'Ship the shorter headline?' } })
  })

  it('moves the waits held back in held-waits.json into the tasks\' waits, then removes the file', async () => {
    const file = join(home, 'held-waits.json')
    const { ledger, brain, r } = setup({ id: 't33', status: 'active', properties: { waiting_on: { who: 'lasse', kind: 'question', why: 'First?', since: '2026-11-17T08:00:00.000Z', session_id: 's37' } } })
    ledger.recordSpawn('s37', null, 'bp-eml', 'claude', false, 't33')
    ledger.recordSpawn('s38', null, 'bp-eml', 'claude', false, 't33')
    ledger.recordSpawn('s39', null, 'bp-eml', 'claude', false, 't33')
    ledger.archive('s39')
    writeFileSync(file, JSON.stringify({ t33: [
      { who: 'lasse', kind: 'question', why: 'Use the blue variant?', since: '2026-11-17T08:30:00.000Z', session_id: 's38' },
      { who: 'lasse', kind: 'question', why: 'Gone?', since: '2026-11-17T08:40:00.000Z', session_id: 's39' },
    ], unknown: [{ who: 'lasse', session_id: 'nobody-here' }] }))
    await r.adoptHeldWaits(file)
    expect(waitsOfTask(brain).map((w) => [w.id, w.why])).toEqual([['s37', 'First?'], ['s38', 'Use the blue variant?']])
    expect(existsSync(file)).toBe(false)
    await r.answered('s37')
    expect(brain.task.properties).toMatchObject({ waiting_on: { session_id: 's38', why: 'Use the blue variant?' } })
  })

  it('removes a broken held-waits file and ignores a missing one', async () => {
    const { r, brain } = setup({ id: 't1', status: 'active', properties: {} })
    const broken = join(home, 'held-waits-broken.json')
    writeFileSync(broken, '{ not json')
    await r.adoptHeldWaits(broken)
    expect(existsSync(broken)).toBe(false)
    await r.adoptHeldWaits(join(home, 'none.json'))
    expect(brain.posts).toHaveLength(0)
  })

  it('takes over the wait of a session that was put away (B4)', async () => {
    const { ledger, brain, r } = setup({ id: 't32', status: 'active', properties: { waiting_on: { who: 'lasse', kind: 'question', why: 'old', since: 'x', session_id: 's35' } } })
    ledger.recordSpawn('s35', null, 'bp-eml', 'claude', false, 't32')
    ledger.recordSpawn('s36', null, 'bp-eml', 'claude', false, 't32')
    ledger.archive('s35')
    await r.turnEnded('s36', HANDOFF)
    expect(waitsOfTask(brain).map((w) => w.id)).toEqual(['s36'])
    expect(brain.task.properties).toMatchObject({ waiting_on: { session_id: 's36' } })
  })

  it('writes a wait from an older waiting_on back in the shape core accepts', async () => {
    const { ledger, brain, r } = setup({ id: 't-old', status: 'active', properties: { waiting_on: { who: 'kim', kind: 'later', why: 'reply', since: 'soon' } } })
    ledger.recordSpawn('s-o', null, 'bp-eml', 'claude', false, 't-old')
    await r.turnEnded('s-o', HANDOFF)
    expect(brain.posts[0].body.waits).toEqual([{ id: 'waiting_on', who: 'kim', why: 'reply' }, expect.objectContaining({ id: 's-o' })])
  })

  it('clears the waits of a task that was closed', async () => {
    const { ledger, brain, r } = setup({ id: 't21', status: 'resolved', properties: { waiting_on: { who: 'lasse', why: 'x', since: 's', session_id: 'other' } } })
    ledger.recordSpawn('s22', null, 'bp-eml', 'claude', false, 't21')
    await r.turnEnded('s22', '### Handoff\nResult: done')
    expect(brain.posts).toEqual([{ path: '/task/t21/track', body: { waits: null } }])
  })

  it('a run that comes due on a closed task reopens it first, so the run\'s question reaches the owner instead of being dropped', async () => {
    const { createTaskCommands, TaskCommandStore } = await import('../src/application/task-commands.js')
    const world = (status: string) => {
      const s = setup({ id: 't-run', status, properties: { assignee_ids: ['lasse'] } })
      // The reopen's write, as the brain does it: the status changes with the waits.
      const post = s.brain.post
      s.brain.post = async (path, body) => {
        if (typeof body.status === 'string') s.brain.task.status = body.status
        return post(path, body)
      }
      const commands = createTaskCommands({
        store: new TaskCommandStore(join(home, `commands-${status}-${Math.random()}.json`)), viewer: 'lasse',
        space: () => ({ id: 'main' }) as never, brain: () => s.brain, agentsOf: async () => [],
        createJob: async () => ({ error: 'none' }), changed: () => {}, now: () => Date.now(), log: () => {},
      })
      s.ledger.recordSpawn('s-run', null, 'bp-eml', 'claude', true, 't-run')
      return { ...s, commands }
    }
    // Without the reopen, a closed task waits on nobody: the question is lost.
    const dropped = world('resolved')
    await dropped.r.turnEnded('s-run', HANDOFF)
    expect(dropped.brain.posts).toEqual([])

    const closed = world('resolved')
    expect(await closed.commands.reopenForRun('main', 't-run', { number: 3, jobId: 'job-1', job: 'Daily brief' })).toBe('reopened')
    expect(closed.brain.posts[0].body).toEqual({ status: 'active', waits: null, text: 'Reopened: run 3 of "Daily brief" came due while the task was closed. End its schedule to stop it.' })
    await closed.r.turnEnded('s-run', HANDOFF)
    expect(closed.brain.task.status).toBe('active')
    expect(waitsOfTask(closed.brain)).toEqual([expect.objectContaining({ id: 's-run', who: 'lasse', kind: 'question', why: 'Ship the shorter headline?' })])

    // A task another one replaced is left alone: nothing is written, and the router still drops the question.
    const replaced = world('superseded')
    expect(await replaced.commands.reopenForRun('main', 't-run', { number: 3, jobId: 'job-1', job: 'Daily brief' })).toBe('refused')
    await replaced.r.turnEnded('s-run', HANDOFF)
    expect(replaced.brain.posts).toEqual([])
    expect(replaced.brain.task.status).toBe('superseded')
  })

  it('logs instead of throwing when the brain fails', async () => {
    const { ledger, brain, r, logs } = setup({ id: 't8', status: 'active', properties: {} })
    brain.get = async () => { throw new Error('brain down') }
    ledger.recordSpawn('s9', null, 'bp-eml', 'claude', false, 't8')
    await expect(r.turnEnded('s9', HANDOFF)).resolves.toBeUndefined()
    expect(logs.at(-1)).toContain('brain down')
  })

  it('reads the last reply from a Stop hook: its field, else the transcript', () => {
    expect(router.replyFromStopHook({ last_assistant_message: 'hello' })).toBe('hello')
    const file = join(home, 'transcript.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: HANDOFF }, { type: 'tool_use' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'tool result' } }),
    ].join('\n'))
    expect(router.replyFromStopHook({ transcript_path: file })).toBe(HANDOFF)
    expect(router.replyFromStopHook({ transcript_path: join(home, 'missing.jsonl') })).toBe('')
    expect(router.replyFromStopHook({})).toBe('')
  })
})
