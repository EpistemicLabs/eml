import { describe, expect, it } from 'vitest'
import type { Capability, ProviderCapabilities } from '../src/domain/agent-provider.js'
import { createTurnContexts, hasEndTurnTool, turnContextOf } from '../src/application/turn-context.js'

function setup(opts: { agent?: string | null; task?: Record<string, unknown> | null; fail?: () => boolean } = {}) {
  const gets: string[] = []
  let now = 0
  const brain = {
    async get(path: string) {
      gets.push(path)
      if (opts.fail?.()) throw new Error('down')
      if (path === '/object/user') return { objects: [{ id: 'kim' }, { id: 'sam' }] }
      if (path === '/object/agent') return { objects: [{ id: 'nova' }, { id: 'echo' }] }
      if (opts.task) return opts.task
      throw new Error('not found')
    },
  }
  const space = { id: 'team', agent: opts.agent === undefined ? 'nova' : opts.agent }
  const contexts = createTurnContexts({
    ledger: { get: (id: string) => (id === 's1' ? { spaceId: 'team', taskId: 't1' } : id === 's2' ? { spaceId: 'team', taskId: null } : undefined) as never },
    spaces: { resolve: () => space as never }, brain: () => brain as never, owner: 'kim', now: () => now,
  })
  return { contexts, gets, space, tick: (ms: number) => { now += ms } }
}

describe('turn context', () => {
  it('is this member, the space\'s agent, its users and agents, and the task\'s checkpoint', async () => {
    const { contexts } = setup({ task: { id: 't1', status: 'active', title: 'refund', properties: { display_title: 'Refund from Acme', checkpoint: 'before' } } })
    expect(await contexts.of('s1')).toEqual({
      ctx: { owner: 'kim', agent: 'nova', members: ['kim', 'sam', 'nova', 'echo'], checkpoint: 'before' },
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
    expect(await contexts.handles(space as never)).toEqual(['kim', 'sam', 'nova', 'echo'])
  })

  it('lets the handles expire: a member who joined is known once the list is read again', async () => {
    const { contexts, gets, space, tick } = setup()
    await contexts.handles(space as never)
    tick(5 * 60_000 - 1)
    await contexts.handles(space as never)
    expect(gets).toHaveLength(2)
    tick(1)
    await contexts.handles(space as never)
    expect(gets).toEqual(['/object/user', '/object/agent', '/object/user', '/object/agent'])
  })

  it('is put together in one place: no agent bound goes by a word for the session itself, a checkpoint is there only when set', () => {
    expect(turnContextOf({ owner: 'kim' })).toEqual({ owner: 'kim', agent: 'agent', members: [] })
    expect(turnContextOf({ owner: 'kim', agent: null, members: ['kim', 'sam'], checkpoint: null })).toEqual({ owner: 'kim', agent: 'agent', members: ['kim', 'sam'] })
    expect(turnContextOf({ owner: 'kim', agent: 'nova', checkpoint: 'before' })).toEqual({ owner: 'kim', agent: 'nova', members: [], checkpoint: 'before' })
  })
})

describe('whether a session has the end_turn tool', () => {
  it('is its provider\'s to say, and only for a session in the chat', () => {
    const capabilities = (endTurnTool: Capability) => ({ capabilities: { chat: { supported: true }, endTurnTool, messaging: { supported: true } } as ProviderCapabilities })
    const [withTool, without] = [capabilities({ supported: true }), capabilities({ supported: false, reason: 'says it in its reply' })]
    expect(hasEndTurnTool({ runtime: 'sdk' }, withTool)).toBe(true)
    expect(hasEndTurnTool({ runtime: 'terminal' }, withTool)).toBe(false)
    expect(hasEndTurnTool({ runtime: 'sdk' }, without)).toBe(false)
    expect(hasEndTurnTool(undefined, withTool)).toBe(false)
  })

  it('only Claude\'s chat has it', async () => {
    const { ProviderRegistry } = await import('../src/infrastructure/providers/registry.js')
    const providers = new ProviderRegistry()
    expect(providers.all().filter((p) => p.capabilities.endTurnTool.supported).map((p) => p.id)).toEqual(['claude'])
  })
})
