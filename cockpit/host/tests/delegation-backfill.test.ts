import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backfillDelegationMode, BACKFILL_LINE, type BackfillTask, type DelegationBackfillDeps } from '../src/application/delegation-backfill.js'

const dir = mkdtempSync(join(tmpdir(), 'cockpit-delegation-backfill-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const delegated = (id: string, mode: 'alone' | 'together' = 'alone', owner = 'lasse', status = 'active'): BackfillTask =>
  ({ id, status, properties: { assignee_ids: [owner], delegation: { agent: 'atlas', checkpoint: 'after', mode } } })

function setup(tasks: BackfillTask[], facts: { together?: string[]; handedAlone?: string[]; userOpen?: string[] } = {}, shared = false) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  let reachable = true
  const brain = {
    async get(_path: string, query?: Record<string, unknown>) {
      if (!reachable) throw new Error('brain down')
      const page = tasks.filter((t) => t.status === query?.status)
      const offset = Number(query?.offset ?? 0)
      return { engrams: page.slice(offset, offset + Number(query?.limit ?? 200)) }
    },
    async post(path: string, body: Record<string, unknown>) { posts.push({ path, body }); return {} },
  }
  const space = { id: 'main', name: 'Main', shared }
  const deps: DelegationBackfillDeps = {
    spaces: () => [space as never],
    brain: () => brain as never,
    me: 'lasse',
    together: (id) => facts.together?.includes(id) ?? false,
    handedAlone: (id) => facts.handedAlone?.includes(id) ?? false,
    userSessionOpen: (id) => facts.userOpen?.includes(id) ?? false,
    markerFile: join(dir, `${Math.random()}.json`),
    log: () => {},
  }
  return { deps, posts, down: () => { reachable = false }, up: () => { reachable = true } }
}

describe('the delegation mode backfill', () => {
  it('sets together, with a journal line, where the owner works with the agent now; the rest stays alone', async () => {
    const w = setup(
      [delegated('board'), delegated('chat'), delegated('handed'), delegated('idle'), delegated('already', 'together'), { id: 'plain', status: 'planned', properties: {} }],
      { together: ['board'], userOpen: ['chat', 'handed', 'already'], handedAlone: ['handed'] },
    )
    expect((await backfillDelegationMode(w.deps)).sort()).toEqual(['board', 'chat'])
    expect(w.posts).toContainEqual({ path: '/task/chat/track', body: { delegation: { agent: 'atlas', checkpoint: 'after', mode: 'together' }, text: BACKFILL_LINE('atlas') } })
    expect(w.posts).toHaveLength(2)
  })

  it('runs once per space: a restart does not write again', async () => {
    const w = setup([delegated('chat')], { userOpen: ['chat'] })
    await backfillDelegationMode(w.deps)
    expect(JSON.parse(readFileSync(w.deps.markerFile, 'utf8'))).toEqual({ spaces: ['main'] })
    expect(await backfillDelegationMode(w.deps)).toEqual([])
    expect(w.posts).toHaveLength(1)
  })

  it('tries a space again on the next start when its brain was not reachable', async () => {
    const w = setup([delegated('chat')], { userOpen: ['chat'] })
    w.down()
    expect(await backfillDelegationMode(w.deps)).toEqual([])
    w.up()
    expect(await backfillDelegationMode(w.deps)).toEqual(['chat'])
  })

  it('in a shared space, only this member\'s tasks', async () => {
    const w = setup([delegated('theirs', 'alone', 'dominik')], { userOpen: ['theirs'] }, true)
    expect(await backfillDelegationMode(w.deps)).toEqual([])
  })

  it('reads every page of open tasks', async () => {
    const many = Array.from({ length: 250 }, (_, i) => delegated(`t${i}`, 'alone', 'lasse', 'planned'))
    const w = setup(many, { userOpen: ['t249'] })
    expect(await backfillDelegationMode(w.deps)).toEqual(['t249'])
  })
})
