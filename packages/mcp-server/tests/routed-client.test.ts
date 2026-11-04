import { describe, it, expect, beforeEach } from 'vitest'
import { EmlApiError, type EmlApi } from '../src/http-client'
import { RoutedClient } from '../src/routed-client'

// Routing over a session's two brains (routed-client.ts): each fake brain
// holds engrams by id and records the calls it got.

interface Engram { id: string; type: string; scope: string; updated_at: string }

class FakeBrain implements EmlApi {
  calls: string[] = []
  posted: Array<{ path: string; body: any }> = []
  tags = new Set<string>()
  relations: any[] = []
  constructor(readonly name: string, readonly engrams: Engram[] = []) {}

  async get(path: string, query: Record<string, any> = {}): Promise<unknown> {
    this.calls.push(`GET ${path}`)
    const byId = /^\/engram\/(.+)$/.exec(path)
    if (byId) {
      const e = this.engrams.find((x) => x.id === byId[1])
      if (!e) throw new EmlApiError(404, null, 'not found')
      return query.with_relations === 'true' ? { ...e, relations: [] } : e
    }
    if (path === '/list') {
      const engrams = this.engrams.filter((e) => (!query.scope || e.scope === query.scope) && (!query.type || e.type === query.type))
      return { count: engrams.length, engrams }
    }
    if (path === '/object/tag' && query.id) {
      if (!this.tags.has(query.id)) throw new EmlApiError(404, null, 'no tag')
      return { object: { id: query.id, name: query.id, description: `${query.id} things` } }
    }
    if (path === '/relations') return { count: this.relations.length, relations: this.relations.filter((r) => r.source_id === query.engram || r.target_id === query.engram) }
    if (path === '/brain-state') return { scope: query.scope, markdown: `${this.name} state` }
    return { from: this.name }
  }

  async post(path: string, body: any = {}): Promise<unknown> {
    this.calls.push(`POST ${path}`)
    this.posted.push({ path, body })
    if (path === '/recall') {
      const n = this.engrams.length
      return { query: body.query, engrams: n, markdown: `# EML Recall — "${body.query}"\n\n_${n} engram(s)_\n\n${this.engrams.map((e) => `- ${this.name} ${e.id}`).join('\n')}\n` }
    }
    if (path === '/boot') {
      const markdown = body.part === 'system' ? '## EML System Rules\n- one' : `# EML Boot — ${body.agent}\n- persona`
      return { markdown, version: '1', budget: { limit: body.budget ?? 0, chars: markdown.length, fits: true, situational_title_only: 0 } }
    }
    if (path === '/object/tag' && this.tags.has(body.name)) throw new EmlApiError(400, { error: 'exists' }, 'exists')
    return { from: this.name, path }
  }

  async put(path: string): Promise<unknown> {
    this.calls.push(`PUT ${path}`)
    return { from: this.name }
  }
}

let space: FakeBrain
let agent: FakeBrain
let client: RoutedClient
const SPACE = '0f8fad5b-d9cb-469f-a165-70867728950e'

beforeEach(() => {
  space = new FakeBrain('space', [
    { id: 's-note', type: 'note', scope: 'user.alex', updated_at: '2026-10-02' },
    { id: 's-rule', type: 'rule', scope: 'project.demo', updated_at: '2026-10-04' },
    { id: 's-task', type: 'task', scope: 'project.demo', updated_at: '2026-10-05' },
  ])
  agent = new FakeBrain('agent', [
    { id: 'a-rule', type: 'rule', scope: 'user.alex', updated_at: '2026-10-03' },
    { id: 'a-learning', type: 'learning', scope: 'agent.juno', updated_at: '2026-10-06' },
  ])
  client = new RoutedClient({ space, agent, agentId: 'juno', spaceBrainId: SPACE })
})

const target = (r: unknown) => (r as { from: string }).from

describe('RoutedClient writes', () => {
  it('sends profiles, rules and learnings in the agent\'s and any user\'s scope to the agent brain, all else to the space', async () => {
    expect(target(await client.post('/engram/rule', { scope: 'user.alex' }))).toBe('agent')
    expect(target(await client.post('/engram/profile', { scope: 'agent.juno' }))).toBe('agent')
    expect(target(await client.post('/engram/profile', { scope: 'user.someone-else' }))).toBe('agent')
    expect(target(await client.post('/learning', { scope: 'agent.juno' }))).toBe('agent')
    expect(target(await client.post('/engram/note', { scope: 'user.alex' }))).toBe('space')
    expect(target(await client.post('/engram/rule', { scope: 'project.demo' }))).toBe('space')
    expect(target(await client.post('/engram/profile', { scope: 'entity.acme' }))).toBe('space')
    expect(target(await client.post('/engram/task', { scope: 'agent.juno' }))).toBe('space')
  })

  it('refuses another agent\'s identity, and a learning outside the agent brain', async () => {
    await expect(client.post('/engram/rule', { scope: 'agent.scout' })).rejects.toMatchObject({ status: 403 })
    await expect(client.post('/learning', { scope: 'agent.scout' })).rejects.toThrow(/this session runs as juno/)
    await expect(client.post('/learning', { scope: 'project.demo' })).rejects.toThrow(/A learning is yours and lives in your agent brain/)
    await expect(client.post('/engram/learning', { scope: 'global' })).rejects.toMatchObject({ status: 403 })
    expect(agent.posted).toEqual([])
    expect(space.posted).toEqual([])
  })

  it('brings the space\'s tags along to the agent brain, once', async () => {
    space.tags.add('architecture')
    await client.post('/engram/rule', { scope: 'user.alex', tags: ['architecture', 'unknown-tag'] })
    expect(agent.posted.map((p) => [p.path, p.body])).toEqual([
      ['/object/tag', { name: 'architecture', description: 'architecture things' }],
      ['/engram/rule', { scope: 'user.alex', tags: ['architecture', 'unknown-tag'] }],
    ])
    agent.tags.add('architecture')
    await client.post('/engram/rule', { scope: 'user.alex', tags: ['architecture'] })
    expect(agent.posted.filter((p) => p.path === '/engram/rule')).toHaveLength(2)
  })

  it('changes an engram in the brain that holds it, and refuses a scope change across brains', async () => {
    expect(target(await client.post('/update', { id: 'a-rule', patch: { content: 'x' } }))).toBe('agent')
    expect(target(await client.post('/update', { id: 's-note', patch: { content: 'x' } }))).toBe('space')
    expect(target(await client.post('/learning', { id: 'a-learning', source: 'self', happened: 'again' }))).toBe('agent')
    await expect(client.post('/update', { id: 'a-rule', patch: { scope: 'project.demo' } })).rejects.toMatchObject({ status: 409 })
    await expect(client.post('/update', { id: 'a-rule', patch: { scope: 'agent.scout' } })).rejects.toMatchObject({ status: 403 })
    expect(target(await client.post('/update', { id: 'a-rule', patch: { scope: 'agent.juno' } }))).toBe('agent')
    await expect(client.post('/update', { id: 'nowhere', patch: {} })).rejects.toMatchObject({ status: 404 })
  })

  it('tracks a task in the space, and keeps users and agents in the agent brain, other objects in the space', async () => {
    expect(target(await client.post('/task/s-task/track', { text: 'went on' }))).toBe('space')
    expect(target(await client.post('/object/user', { id: 'sam', name: 'Sam' }))).toBe('agent')
    expect(target(await client.get('/object/agent', { id: 'juno' }))).toBe('agent')
    expect(target(await client.put('/object/agent/juno', { name: 'Juno' }))).toBe('agent')
    expect(target(await client.post('/object/project', { id: 'p', name: 'P' }))).toBe('space')
    expect(target(await client.get('/object/tag'))).toBe('space')
    expect(target(await client.put('/object/project/p', { name: 'Q' }))).toBe('space')
  })
})

describe('RoutedClient relations', () => {
  it('writes a relation inside one brain there, and one across brains into the agent brain naming the space', async () => {
    await client.post('/relate', { source_id: 's-note', target_id: 's-rule', relation: 'related_to' })
    await client.post('/relate', { source_id: 'a-learning', target_id: 'a-rule', relation: 'refines' })
    await client.post('/relate', { source_id: 'a-learning', target_id: 's-task', relation: 'refines' })
    await client.post('/relate', { source_id: 's-task', target_id: 'a-learning', relation: 'related_to' })
    expect(space.posted.map((p) => p.body)).toEqual([{ source_id: 's-note', target_id: 's-rule', relation: 'related_to' }])
    expect(agent.posted.map((p) => p.body)).toEqual([
      { source_id: 'a-learning', target_id: 'a-rule', relation: 'refines' },
      { source_id: 'a-learning', target_id: 's-task', relation: 'refines', target_brain: SPACE },
      { source_id: 's-task', target_id: 'a-learning', relation: 'related_to', source_brain: SPACE },
    ])
  })

  it('lists the agent brain\'s links to a space engram when it is read with its relations', async () => {
    agent.relations.push({ source_id: 'a-learning', target_id: 's-task', relation: 'refines', source_brain: null, target_brain: SPACE })
    agent.relations.push({ source_id: 'a-learning', target_id: 'a-rule', relation: 'refines', source_brain: null, target_brain: null })
    expect(await client.get('/engram/s-task')).toEqual(space.engrams[2])
    const withLinks = (await client.get('/engram/s-task', { with_relations: 'true' })) as any
    expect(withLinks.relations).toEqual([])
    expect(withLinks.agent_links).toEqual([agent.relations[0]])
    expect(((await client.get('/engram/s-note', { with_relations: 'true' })) as any).agent_links).toBeUndefined()
  })
})

describe('RoutedClient reads', () => {
  it('gets by id from the space, then the agent brain; the error is the space\'s when neither has it', async () => {
    expect(await client.get('/engram/s-note')).toMatchObject({ id: 's-note' })
    expect(await client.get('/engram/a-rule')).toMatchObject({ id: 'a-rule' })
    await expect(client.get('/engram/nowhere')).rejects.toMatchObject({ status: 404 })
  })

  it('merges a recall and a show of an own scope, and shows another scope from the space', async () => {
    const recall = (await client.post('/recall', { query: 'x' })) as { engrams: number; markdown: string }
    expect(recall.engrams).toBe(5)
    expect(recall.markdown).toBe('# EML Recall — "x"\n\n_5 engram(s)_\n\n- space s-note\n- space s-rule\n- space s-task\n\n- agent a-rule\n- agent a-learning')
    expect((await client.get('/brain-state', { scope: 'user.alex' }) as any).markdown).toBe('agent state\n\nspace state')
    expect((await client.get('/brain-state', { scope: 'agent.juno' }) as any).markdown).toBe('agent state\n\nspace state')
    expect((await client.get('/brain-state', { scope: 'project.demo' }) as any).markdown).toBe('space state')
    expect(agent.calls.filter((c) => c.startsWith('GET /brain-state'))).toHaveLength(2)
  })

  it('lists from the brain the filters point at, else from both, newest first', async () => {
    expect(await client.get('/list', { scope: 'user.alex', type: 'rule' })).toMatchObject({ count: 1 })
    expect(space.calls.filter((c) => c === 'GET /list')).toHaveLength(0)
    expect(await client.get('/list', { type: 'note' })).toMatchObject({ count: 1 })
    expect(await client.get('/list', { scope: 'project.demo' })).toMatchObject({ count: 2 })
    expect(agent.calls.filter((c) => c === 'GET /list')).toHaveLength(1)
    const both = (await client.get('/list', { limit: 3 })) as { count: number; engrams: Engram[] }
    expect(both.engrams.map((e) => e.id)).toEqual(['a-learning', 's-task', 's-rule'])
  })

  it('boots the agent part within what the system rules leave of the budget, and refuses another agent', async () => {
    const boot = (await client.post('/boot', { budget: 1000 })) as any
    expect(boot.markdown).toBe('# EML Boot — juno\n- persona\n\n## EML System Rules\n- one')
    expect(boot.budget).toMatchObject({ limit: 1000, chars: boot.markdown.length, fits: true })
    expect(space.posted.map((p) => p.body)).toEqual([{ part: 'system' }])
    expect(agent.posted.map((p) => p.body)).toEqual([{ part: 'identity', agent: 'juno', budget: 1000 - '## EML System Rules\n- one'.length - 2 }])
    expect(target(await client.post('/boot', { agent: 'juno' }))).toBeUndefined()
    await expect(client.post('/boot', { agent: 'scout' })).rejects.toMatchObject({ status: 403 })
  })

  it('sends the project block, stats and everything else to the space', async () => {
    expect(target(await client.post('/project-block', { scope: 'project.demo' }))).toBe('space')
    expect(target(await client.get('/stats'))).toBe('space')
  })
})
