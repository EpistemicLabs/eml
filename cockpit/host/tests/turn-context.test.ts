import { describe, expect, it } from 'vitest'
import type { Capability, ProviderCapabilities } from '../src/domain/agent-provider.js'
import { createTurnContexts, endTurnAccess, hasEndTurnTool, turnContextOf } from '../src/application/turn-context.js'

function setup(opts: { agent?: string | null; task?: Record<string, unknown> | null; fail?: () => boolean; steps?: { open: number; covered: boolean } | null } = {}) {
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
    ...(opts.steps !== undefined ? { stepsOf: (taskId: string) => (taskId === 't1' ? opts.steps! : null) } : {}),
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

  it('carries the task\'s open steps from the board, and none when it has none', async () => {
    const task = { id: 't1', status: 'active', title: 'refund' }
    expect((await setup({ task, steps: { open: 2, covered: true } }).contexts.of('s1')).ctx.steps).toEqual({ open: 2, covered: true })
    expect((await setup({ task, steps: null }).contexts.of('s1')).ctx).not.toHaveProperty('steps')
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
  const NO: Capability = { supported: false, reason: 'not here' }
  const capabilities = (endTurnTool: Capability, terminalTools: Capability = NO) =>
    ({ capabilities: { chat: { supported: true }, endTurnTool, messaging: { supported: true }, terminalTools } as ProviderCapabilities })

  it('is its provider\'s to say: for a session in the chat, and in a terminal only when its terminal sessions get the cockpit\'s tools', () => {
    const [withTool, without] = [capabilities({ supported: true }), capabilities({ supported: false, reason: 'says it in its reply' })]
    expect(hasEndTurnTool({ runtime: 'sdk' }, withTool)).toBe(true)
    expect(hasEndTurnTool({ runtime: 'terminal' }, withTool)).toBe(false)
    expect(hasEndTurnTool({ runtime: 'sdk' }, without)).toBe(false)
    expect(hasEndTurnTool(undefined, withTool)).toBe(false)
    const served = capabilities({ supported: true }, { supported: true })
    expect(hasEndTurnTool({ runtime: 'terminal' }, served)).toBe(true)
    expect(hasEndTurnTool({ runtime: 'sdk' }, served)).toBe(true)
    expect(hasEndTurnTool(undefined, served)).toBe(false)
    // The tools alone are not the end_turn tool.
    expect(hasEndTurnTool({ runtime: 'terminal' }, capabilities(NO, { supported: true }))).toBe(false)
  })

  it('a session whose provider\'s sessions get the tools from the MCP server has it from there, in a terminal and in the chat; another\'s chat session has it built in', () => {
    const served = capabilities({ supported: true }, { supported: true })
    // Codex in the chat: its app-server reaches the tool on the host's endpoint, so the texts name the server.
    expect(endTurnAccess({ runtime: 'sdk' }, served, 'cockpit')).toEqual({ mcpServer: 'cockpit' })
    expect(endTurnAccess({ runtime: 'terminal' }, served, 'cockpit')).toEqual({ mcpServer: 'cockpit' })
    // Claude Code in the chat.
    expect(endTurnAccess({ runtime: 'sdk' }, capabilities({ supported: true }), 'cockpit')).toBe(true)
    expect(endTurnAccess({ runtime: 'terminal' }, capabilities({ supported: true }), 'cockpit')).toBe(false)
    expect(endTurnAccess(undefined, served, 'cockpit')).toBe(false)
  })

  it('Claude has it in the chat only, the terminal-only providers in the terminal', async () => {
    const { ProviderRegistry } = await import('../src/infrastructure/providers/registry.js')
    const providers = new ProviderRegistry()
    const inTerminal = providers.all().filter((p) => hasEndTurnTool({ runtime: 'terminal' }, p)).map((p) => p.id)
    expect(inTerminal).toEqual(providers.all().map((p) => p.id).filter((id) => id !== 'claude'))
    expect(inTerminal).toContain('codex')
    expect(hasEndTurnTool({ runtime: 'sdk' }, providers.get('claude')!)).toBe(true)
  })
})
