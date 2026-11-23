import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The router's writes against a real core brain (schema 23): core accepts the
// waits it sends, keeps waiting_on as the most urgent wait, and refuses a stale
// base_rev, so the router reads again instead of dropping another wait.

const home = mkdtempSync(join(tmpdir(), 'cockpit-task-router-core-'))
process.env.EML_COCKPIT_HOME = home
const require = createRequire(import.meta.url)
const core = require('@engramprotocol/core')

type Router = typeof import('../src/application/task-router.js')
type Ledger = typeof import('../src/session-ledger.js')['SessionLedger']

const ask = (q: string) => `### Handoff\nResult: built it\nQuestions:\n- [lasse] ${q}`

describe('the router on a real brain', () => {
  let router: Router
  let SessionLedger: Ledger
  beforeAll(async () => {
    router = await import('../src/application/task-router.js')
    SessionLedger = (await import('../src/session-ledger.js')).SessionLedger
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const world = () => {
    const eml = new core.EML({ dbPath: ':memory:', namespace: 'test' })
    const run = (name: string, input: unknown) => eml.apply({ name, input })
    run('object.create', { object: 'project', fields: { id: 'eml', name: 'EML' } })
    const task = run('engram.create', { type: 'task', title: 'router-core-task', content: 'a task', scope: 'project.eml', status: 'active', properties: {} })
    let before: (() => void) | null = null
    const brain = {
      async get(path: string) { return eml.engrams.getRaw(path.split('/')[2]) },
      async post(path: string, body: Record<string, unknown>) {
        before?.(); before = null
        try {
          return run('task.track', { ...body, id: path.split('/')[2] })
        } catch (err) {
          if ((err as { code?: string }).code === 'CONFLICT') throw Object.assign(new Error((err as Error).message), { status: 409 })
          throw err
        }
      },
    }
    const ledger = new SessionLedger()
    for (const s of ['s1', 's2']) ledger.recordSpawn(s, null, 'bp-eml', 'claude', false, task.id)
    const logs: string[] = []
    const r = router.createTaskRouter({ ledger, spaces: { resolve: () => ({ shared: false }) as never }, brain: () => brain, owner: 'lasse', log: (l) => logs.push(l) })
    const props = () => eml.engrams.getRaw(task.id).properties as Record<string, any>
    return { eml, run, task, r, props, logs, interleave: (fn: () => void) => { before = fn } }
  }

  it('two sessions ask, core puts the older on waiting_on; an answer brings up the next', async () => {
    const w = world()
    await w.r.turnEnded('s1', ask('First?'))
    await w.r.turnEnded('s2', ask('Second?'))
    expect(w.props().waits.map((x: any) => [x.id, x.why])).toEqual([['s1', 'First?'], ['s2', 'Second?']])
    expect(w.props().waiting_on).toMatchObject({ session_id: 's1', why: 'First?', kind: 'question' })
    await w.r.answered('s1')
    expect(w.props().waiting_on).toMatchObject({ session_id: 's2', why: 'Second?' })
    await w.r.answered('s2')
    expect(w.props().waits).toBeUndefined()
    expect(w.props().waiting_on).toBeUndefined()
    expect(w.logs.filter((l) => l.includes('failed'))).toEqual([])
    w.eml.close()
  })

  it('a write that came in between is not lost: the stale rev is refused and the router redoes its change', async () => {
    const w = world()
    w.interleave(() => w.run('task.track', { id: w.task.id, waits: [{ id: 'other', who: 'lasse', kind: 'review', why: 'Review: x', session_id: 'other' }] }))
    await w.r.turnEnded('s1', ask('First?'))
    expect(w.props().waits.map((x: any) => x.id)).toEqual(['other', 's1'])
    expect(w.props().waiting_on).toMatchObject({ session_id: 'other', kind: 'review' })
    w.eml.close()
  })

  it('a wait from an older waiting_on with odd values is written back in a shape core takes', async () => {
    const w = world()
    w.run('task.track', { id: w.task.id, waiting_on: { who: 'kim', kind: 'later', why: 'reply', since: 'soon' } })
    await w.r.turnEnded('s1', ask('First?'))
    expect(w.props().waits.map((x: any) => x.id)).toEqual(['waiting_on', 's1'])
    expect(w.logs.filter((l) => l.includes('failed'))).toEqual([])
    w.eml.close()
  })
})
