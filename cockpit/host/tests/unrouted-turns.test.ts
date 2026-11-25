import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-unrouted-'))
process.env.EML_COCKPIT_HOME = home

type Router = typeof import('../src/application/task-router.js')
type Unrouted = typeof import('../src/application/unrouted-turns.js')
type Ledger = typeof import('../src/session-ledger.js')['SessionLedger']

const NOW = Date.parse('2026-11-25T08:25:00Z')
const SPACE = { shared: false, agent: 'atlas' }

/** A brain with one task: a track write merges the waits and keeps the journal text. */
function fakeBrain(task: Record<string, unknown>) {
  const posts: Array<Record<string, unknown>> = []
  return {
    posts, task, down: false,
    /** The next write lands, then the call fails anyway (a timeout after the brain wrote it). */
    lostAnswer: false,
    async get() {
      if (this.down) throw new Error('brain down')
      return structuredClone(task)
    },
    async post(_path: string, body: Record<string, unknown>) {
      const { base_rev: _rev, ...rest } = body
      posts.push(rest)
      if ('waits' in rest) task.properties = { ...(task.properties as object), waits: rest.waits }
      if (typeof rest.text === 'string') task.entries = [...((task.entries as unknown[]) ?? []), { kind: 'note', at: new Date().toISOString(), text: rest.text }]
      if (this.lostAnswer) { this.lostAnswer = false; throw new Error('POST timed out after 30000ms') }
      return task
    },
  }
}

describe('turns left over by a host going down', () => {
  let router: Router
  let unrouted: Unrouted
  let SessionLedger: Ledger
  beforeAll(async () => {
    router = await import('../src/application/task-router.js')
    unrouted = await import('../src/application/unrouted-turns.js')
    SessionLedger = (await import('../src/session-ledger.js')).SessionLedger
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const world = (ledger = new SessionLedger()) => {
    const brain = fakeBrain({ id: 't1', status: 'active', properties: {} })
    const logs: string[] = []
    const r = router.createTaskRouter({
      ledger, spaces: { resolve: () => SPACE as never }, brain: () => brain, owner: 'lasse', handles: async () => ['lasse', 'atlas'],
      routed: (sessionId, at) => ledger.clearUnrouted(sessionId, at),
      log: (l) => logs.push(l), now: () => new Date(NOW),
    })
    const working = new Set<string>()
    const leftovers = () => unrouted.routeUnrouted({ ledger, router: r, working: (id) => working.has(id), log: (l) => logs.push(l), now: () => NOW })
    return { ledger, brain, r, logs, working, leftovers }
  }

  it('routes a status question whose turn ended while the host went down, once the host runs again', async () => {
    const before = new SessionLedger()
    before.recordSpawn('s1', null, 'bp-eml', 'claude', true, 't1')
    // session_status question mid-turn; the turn's end never reached the router (the host was closing).
    before.setAttention('s1', { kind: 'question', reason: 'Please install alpha.15' })
    before.setUnrouted('s1', { call: null, ctx: null })

    // The next host reads the same ledger file.
    const after = world(new SessionLedger())
    expect(after.ledger.get('s1')!.unrouted).toBeTruthy()
    expect(await after.leftovers()).toBe(1)
    expect(after.brain.task.properties).toMatchObject({ waits: [{ who: 'lasse', kind: 'question', why: 'Please install alpha.15', session_id: 's1' }] })
    expect(after.ledger.get('s1')!.unrouted).toBeUndefined()
    // Routed once: the next tick finds nothing left.
    expect(await after.leftovers()).toBe(0)
    expect(after.brain.posts).toHaveLength(1)
  })

  it('routes a left-over end_turn call as the call, read against the context it was answered with', async () => {
    const w = world()
    w.ledger.recordSpawn('s2', null, 'bp-eml', 'claude', true, 't1')
    const ctx = { owner: 'lasse', agent: 'atlas', members: ['lasse', 'atlas'] }
    w.ledger.setAttention('s2', { kind: 'question', reason: 'Merge PR #300?' })
    w.ledger.setUnrouted('s2', { call: { result: 'PR #300 is open.', questions: ['Merge PR #300?'] }, ctx })
    await w.leftovers()
    expect(w.brain.posts[0].text).toContain('PR #300 is open.')
    expect(w.brain.task.properties).toMatchObject({ waits: [{ who: 'lasse', kind: 'question', why: 'Merge PR #300?' }] })
  })

  it('keeps what a session said while its route fails, and tries again on the next tick', async () => {
    const w = world()
    w.ledger.recordSpawn('s3', null, 'bp-eml', 'claude', true, 't1')
    w.ledger.setAttention('s3', { kind: 'question', reason: 'Which customer?' })
    w.ledger.setUnrouted('s3', { call: null, ctx: null })
    w.brain.down = true
    await w.r.turnEnded('s3', '')
    expect(w.ledger.get('s3')!.unrouted).toBeTruthy()
    w.brain.down = false
    await w.leftovers()
    expect(w.ledger.get('s3')!.unrouted).toBeUndefined()
    expect(w.brain.task.properties).toMatchObject({ waits: [{ kind: 'question', why: 'Which customer?' }] })
  })

  it('writes the block once when a route is tried again after its write landed but its answer was lost', async () => {
    const w = world()
    w.ledger.recordSpawn('s7', null, 'bp-eml', 'claude', true, 't1')
    const ctx = { owner: 'lasse', agent: 'atlas', members: ['lasse', 'atlas'] }
    w.ledger.setAttention('s7', { kind: 'question', reason: 'Merge?' })
    w.ledger.setUnrouted('s7', { call: { result: 'PR open.', questions: ['Merge?'] }, ctx })
    w.brain.lostAnswer = true
    await w.r.turnEnded('s7', '', { result: 'PR open.', questions: ['Merge?'] }, { ctx })
    expect(w.ledger.get('s7')!.unrouted).toBeTruthy()
    // After a restart the router remembers nothing: only the task's journal says the block is there.
    const fresh = world(w.ledger)
    fresh.brain.task.entries = w.brain.task.entries
    fresh.brain.task.properties = w.brain.task.properties
    await fresh.leftovers()
    expect(fresh.brain.posts.filter((p) => typeof p.text === 'string')).toHaveLength(0)
    expect(fresh.ledger.get('s7')!.unrouted).toBeUndefined()
  })

  it('clears it once the turn end routed it, so nothing is routed twice', async () => {
    const w = world()
    w.ledger.recordSpawn('s4', null, 'bp-eml', 'claude', true, 't1')
    w.ledger.setAttention('s4', { kind: 'question', reason: 'OK?' })
    w.ledger.setUnrouted('s4', { call: null, ctx: null })
    await w.r.turnEnded('s4', '')
    expect(w.ledger.get('s4')!.unrouted).toBeUndefined()
    expect(await w.leftovers()).toBe(0)
  })

  it('leaves a session in a turn, one being routed and one put away alone', async () => {
    const w = world()
    for (const id of ['busy', 'routing', 'away']) {
      w.ledger.recordSpawn(id, null, 'bp-eml', 'claude', true, 't1')
      w.ledger.setAttention(id, { kind: 'question', reason: id })
      w.ledger.setUnrouted(id, { call: null, ctx: null })
    }
    w.working.add('busy')
    w.ledger.archive('away')
    let release: () => void = () => {}
    let entered: () => void = () => {}
    const reading = new Promise<void>((r) => { entered = r })
    w.brain.get = async function () { entered(); await new Promise<void>((r) => { release = r }); return structuredClone(this.task) }
    const pending = w.r.turnEnded('routing', '')
    await reading
    expect(await w.leftovers()).toBe(0)
    release()
    await pending
    expect(w.ledger.get('away')!.unrouted).toBeUndefined()
  })

  it('drops what is older than a day instead of putting a stale question on the task', async () => {
    const w = world()
    w.ledger.recordSpawn('old', null, 'bp-eml', 'claude', true, 't1')
    w.ledger.setAttention('old', { kind: 'question', reason: 'Install alpha.15?' })
    w.ledger.setUnrouted('old', { call: null, ctx: null })
    const late = () => unrouted.routeUnrouted({ ledger: w.ledger, router: w.r, working: () => false, log: (l) => w.logs.push(l), now: () => Date.now() + unrouted.MAX_AGE_MS + 60_000 })
    expect(await late()).toBe(0)
    expect(w.brain.posts).toHaveLength(0)
    expect(w.ledger.get('old')!.unrouted).toBeUndefined()
    expect(w.logs.at(-1)).toContain('older than a day')
  })

  it('forgets it when the user answers: the attention is cleared', () => {
    const ledger = new SessionLedger()
    ledger.recordSpawn('s5', null, 'bp-eml', 'claude', true, 't1')
    ledger.setAttention('s5', { kind: 'question', reason: 'Go?' })
    ledger.setUnrouted('s5', { call: null, ctx: null })
    ledger.setAttention('s5', null)
    expect(ledger.get('s5')!.unrouted).toBeUndefined()
  })

  it('keeps what the session said after the one being cleared', () => {
    const ledger = new SessionLedger()
    ledger.recordSpawn('s6', null, 'bp-eml', 'claude', true, 't1')
    ledger.setUnrouted('s6', { call: null, ctx: null })
    const first = ledger.get('s6')!.unrouted!.at
    ledger.clearUnrouted('s6', '2000-01-01T00:00:00.000Z')
    expect(ledger.get('s6')!.unrouted!.at).toBe(first)
    ledger.clearUnrouted('s6', first)
    expect(ledger.get('s6')!.unrouted).toBeUndefined()
  })
})
