import { describe, expect, it } from 'vitest'
import { createTurnContexts } from '../src/application/turn-context.js'

function setup(opts: { agent?: string | null; task?: Record<string, unknown> | null; fail?: () => boolean } = {}) {
  const gets: string[] = []
  let now = 0
  const brain = {
    async get(path: string) {
      gets.push(path)
      if (opts.fail?.()) throw new Error('down')
      if (path === '/object/user') return { objects: [{ id: 'lasse' }, { id: 'dominik' }] }
      if (path === '/object/agent') return { objects: [{ id: 'atlas' }, { id: 'motti' }] }
      if (opts.task) return opts.task
      throw new Error('not found')
    },
  }
  const space = { id: 'team', agent: opts.agent === undefined ? 'atlas' : opts.agent }
  const contexts = createTurnContexts({
    ledger: { get: (id: string) => (id === 's1' ? { spaceId: 'team', taskId: 't1' } : id === 's2' ? { spaceId: 'team', taskId: null } : undefined) as never },
    spaces: { resolve: () => space as never }, brain: () => brain as never, owner: 'lasse', now: () => now,
  })
  return { contexts, gets, space, tick: (ms: number) => { now += ms } }
}

describe('turn context', () => {
  it('is this member, the space\'s agent, its users and agents, and the task\'s checkpoint', async () => {
    const { contexts } = setup({ task: { id: 't1', status: 'active', title: 'refund', properties: { display_title: 'Refund from Acme', checkpoint: 'before' } } })
    expect(await contexts.of('s1')).toEqual({
      ctx: { owner: 'lasse', agent: 'atlas', members: ['lasse', 'dominik', 'atlas', 'motti'], checkpoint: 'before' },
      task: { id: 't1', name: 'Refund from Acme', open: true },
    })
  })

  it('a session without a task, or whose task cannot be read, has none; a closed task is not open', async () => {
    expect((await setup().contexts.of('s2')).task).toBeNull()
    expect((await setup({ task: null }).contexts.of('s1')).task).toBeNull()
    expect((await setup({ task: { id: 't1', status: 'resolved', title: 'Refund' } }).contexts.of('s1')).task).toEqual({ id: 't1', name: 'Refund', open: false })
  })

  it('a space without an agent goes by a word that names the session itself', async () => {
    expect((await setup({ agent: null }).contexts.of('s2')).ctx.agent).toBe('agent')
  })

  it('reads the handles once per space for a while, and keeps the last list when the brain does not answer', async () => {
    let down = false
    const { contexts, gets, space, tick } = setup({ fail: () => down })
    await contexts.handles(space as never)
    await contexts.handles(space as never)
    expect(gets).toEqual(['/object/user', '/object/agent'])
    tick(6 * 60_000)
    down = true
    expect(await contexts.handles(space as never)).toEqual(['lasse', 'dominik', 'atlas', 'motti'])
  })
})
