import { EmlApiError, type EmlApi } from './http-client'

/**
 * One session, two brains (the EML cockpit, decision
 * cockpit-identity-agent-brain): the space's brain for what the session works
 * on, and the bound agent's brain for who it is and whom it works with. The
 * tools keep calling one EML API; this client routes each call by the
 * engram's scope, so an agent needs no idea of the split.
 *
 * Identity is the agent's persona, rules and learnings in agent.<bound> and
 * the profiles of the people it works with in user.<handle> — any handle. It
 * lives in the agent brain. Everything else is work and stays in the space: a
 * project's rules, an entity's profile, and tasks, decisions, notes and logs
 * whatever their scope. A rule or learning in a user scope is routed to the
 * agent brain and refused there by the server (user.<handle> holds a
 * profile only).
 *
 *   create a profile/rule/learning  agent.<bound> or user.* → agent brain;
 *                                   agent.<other> → refused (another agent's
 *                                   identity); a learning elsewhere → refused
 *                                   here (a learning is the agent's own);
 *                                   else the space
 *   change by id (update, learning  the brain that holds the id; a scope change
 *   evidence)                       that would cross brains is refused
 *   track a task                    the space (a task never leaves it)
 *   relate                          both ends in one brain → that brain; one in
 *                                   each → the agent brain, as a cross-brain
 *                                   reference naming the space (source_brain /
 *                                   target_brain; a space never holds one)
 *   get by id                       the space, then the agent brain; a space
 *                                   engram read with its relations also lists
 *                                   the agent brain's links to it (agent_links)
 *   recall; list, show in an own    both, merged
 *   scope
 *   boot                            the agent part from the agent brain, the
 *                                   system rules from the space's server; one
 *                                   budget, the agent part gets what the system
 *                                   rules leave; another agent is not readable
 *   objects                         user and agent → agent brain; else the space
 *   everything else                 the space
 *
 * A write to the agent brain brings its tags and subjects along from the
 * space's vocabulary (creating them is idempotent), so a tag the agent found
 * registered is registered where the engram lands.
 */

const IDENTITY_TYPES = new Set(['profile', 'rule', 'learning'])
const IDENTITY_OBJECTS = new Set(['user', 'agent'])

export interface RoutedClientOptions {
  space: EmlApi
  agent: EmlApi
  /** The bound agent's id: agent.<id> is this session's own scope. */
  agentId: string
  /** The space brain's id (its genesis brain id), which a cross-brain reference names. */
  spaceBrainId: string
}

type Query = Record<string, string | number | undefined>
type Body = Record<string, unknown>

export class RoutedClient implements EmlApi {
  private readonly space: EmlApi
  private readonly agent: EmlApi
  private readonly agentId: string
  private readonly spaceBrainId: string

  constructor(opts: RoutedClientOptions) {
    this.space = opts.space
    this.agent = opts.agent
    this.agentId = opts.agentId
    this.spaceBrainId = opts.spaceBrainId
  }

  /** agent.<bound> and every user.<handle>: the scopes whose identity engrams live in the agent brain. */
  private own(scope: string): boolean {
    return scope === `agent.${this.agentId}` || scope.startsWith('user.')
  }

  async get(path: string, query?: Query): Promise<unknown> {
    if (path.startsWith('/engram/')) return this.getEngram(path, query)
    if (path === '/list') return this.list(query ?? {})
    if (path === '/brain-state' && this.own(String(query?.scope))) {
      const [space, agent] = await Promise.all([this.space.get(path, query), this.agent.get(path, query)])
      return { scope: query?.scope, markdown: joinMarkdown(markdownOf(agent), markdownOf(space)) }
    }
    const object = objectKind(path)
    if (object && IDENTITY_OBJECTS.has(object)) return this.agent.get(path, query)
    return this.space.get(path, query)
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    const b = (body ?? {}) as Body
    const create = /^\/engram\/([a-z]+)$/.exec(path)
    if (create) return this.write(create[1], b, (api) => api.post(path, body))
    if (path === '/learning') {
      if (typeof b.id === 'string') return (await this.owner(b.id)).api.post(path, body)
      return this.write('learning', b, (api) => api.post(path, body))
    }
    if (path === '/update') return this.update(b, body)
    if (path === '/relate') return this.relate(b)
    if (path === '/recall') {
      const [space, agent] = await Promise.all([this.space.post(path, body), this.agent.post(path, body)])
      return mergeRecall(space as Body, agent as Body)
    }
    if (path === '/boot') return this.boot(b)
    const object = objectKind(path)
    if (object && IDENTITY_OBJECTS.has(object)) return this.agent.post(path, body)
    return this.space.post(path, body)
  }

  async put(path: string, body?: unknown): Promise<unknown> {
    const object = objectKind(path)
    if (object && IDENTITY_OBJECTS.has(object)) return this.agent.put(path, body)
    return this.space.put(path, body)
  }

  /** The brain a new engram of `type` in `scope` belongs to; refuses what belongs to no brain of this session. */
  private brainFor(type: string, scope: string): EmlApi {
    if (!IDENTITY_TYPES.has(type)) return this.space
    if (this.own(scope)) return this.agent
    if (scope.startsWith('agent.')) {
      throw new EmlApiError(403, null, `${scope} is another agent's identity; this session runs as ${this.agentId}. Write it in a session of that agent.`)
    }
    if (type === 'learning') {
      throw new EmlApiError(403, null, `A learning is yours and lives in your agent brain: scope agent.${this.agentId}, also for a lesson about working with a person (user.<handle> holds their profile). Link the task or project it came from with eml_relate.`)
    }
    return this.space
  }

  private async write(type: string, body: Body, send: (api: EmlApi) => Promise<unknown>): Promise<unknown> {
    const api = this.brainFor(type, String(body.scope))
    if (api === this.agent) await this.bringVocabulary(body)
    return send(api)
  }

  /** The space's tags and subjects of an agent-brain write, registered there too. */
  private async bringVocabulary(body: Body): Promise<void> {
    const kinds: Array<['tag' | 'subject', unknown]> = [['tag', body.tags], ['subject', body.subjects]]
    for (const [kind, ids] of kinds) {
      if (!Array.isArray(ids)) continue
      for (const id of ids) {
        const found = await this.space.get(`/object/${kind}`, { id: String(id) }).catch(() => null) as { object?: Body } | null
        if (!found?.object) continue // unknown in the space too: the write reports it
        const { name, description } = found.object
        await this.agent.post(`/object/${kind}`, { name, ...(description ? { description } : {}) }).catch((err: unknown) => {
          // Registered there already: nothing to bring.
          if (!(err instanceof EmlApiError) || err.status !== 400) throw err
        })
      }
    }
  }

  private async update(b: Body, body: unknown): Promise<unknown> {
    const { api, engram } = await this.owner(String(b.id))
    const scope = (b.patch as Body | undefined)?.scope
    if (typeof scope === 'string') {
      // Not a brain of this session (another agent's identity): brainFor refuses.
      if (this.brainFor(String(engram.type), scope) !== api) {
        throw new EmlApiError(409, null, `Moving ${b.id} to ${scope} would move it between the space and your agent brain — not supported. Write it anew in ${scope} and invalidate the old one.`)
      }
    }
    return api.post('/update', body)
  }

  /**
   * A relation between two engrams of one brain is written there. One end in
   * the space and one in the agent brain: written into the agent brain, with
   * the space's brain id on the space's end — the space holds no reference
   * into another brain (core relation.create).
   */
  private async relate(b: Body): Promise<unknown> {
    const [source, target] = await Promise.all([this.owner(String(b.source_id)), this.owner(String(b.target_id))])
    if (source.api === target.api) return source.api.post('/relate', b)
    const brain = source.api === this.space ? { source_brain: this.spaceBrainId } : { target_brain: this.spaceBrainId }
    return this.agent.post('/relate', { ...b, ...brain })
  }

  /**
   * The session's boot: the agent part (persona, the people it works with,
   * rules) from the agent brain, the system rules from the space's server. One
   * budget: the system rules are fixed, the agent part gets the rest.
   */
  private async boot(b: Body): Promise<unknown> {
    if (typeof b.agent === 'string' && b.agent && b.agent !== this.agentId) {
      throw new EmlApiError(403, null, `${b.agent} is another agent; this session runs as ${this.agentId}, and another agent's brain is not readable from here.`)
    }
    const system = markdownOf(await this.space.post('/boot', { part: 'system' }))
    const budget = typeof b.budget === 'number' && Number.isFinite(b.budget) && b.budget > 0 ? Math.floor(b.budget) : undefined
    const remaining = budget !== undefined ? budget - system.length - 2 : undefined
    const identity = (await this.agent.post('/boot', {
      part: 'identity', agent: this.agentId, ...(remaining !== undefined && remaining > 0 ? { budget: remaining } : {}),
    })) as Body
    const markdown = joinMarkdown(markdownOf(identity), system)
    const report = identity.budget as Body | undefined
    return {
      ...identity,
      markdown,
      ...(report && budget !== undefined
        ? { budget: { ...report, limit: budget, chars: markdown.length, fits: report.fits !== false && markdown.length <= budget } }
        : {}),
    }
  }

  /** The brain that holds engram `id`, with the engram: the space, else the agent brain. */
  private async owner(id: string): Promise<{ api: EmlApi; engram: Body }> {
    try {
      return { api: this.space, engram: (await this.space.get(`/engram/${id}`)) as Body }
    } catch (err) {
      if (!(err instanceof EmlApiError) || err.status !== 404) throw err
      return { api: this.agent, engram: (await this.agent.get(`/engram/${id}`)) as Body } // a 404 here is the caller's error
    }
  }

  /**
   * An engram by id from the space, else from the agent brain. A space engram
   * read with its relations also carries the agent brain's references to it —
   * the learnings and links the agent keeps about this work.
   */
  private async getEngram(path: string, query?: Query): Promise<unknown> {
    let engram: Body
    try {
      engram = (await this.space.get(path, query)) as Body
    } catch (err) {
      if (!(err instanceof EmlApiError) || err.status !== 404) throw err
      try {
        return await this.agent.get(path, query)
      } catch {
        throw err
      }
    }
    if (String(query?.with_relations) !== 'true') return engram
    const id = path.slice('/engram/'.length)
    const links = (await this.agent.get('/relations', { engram: id }).catch(() => null)) as { relations?: Body[] } | null
    const agentLinks = (links?.relations ?? []).filter((r) => r.source_brain === this.spaceBrainId || r.target_brain === this.spaceBrainId)
    return agentLinks.length > 0 ? { ...engram, agent_links: agentLinks } : engram
  }

  private async list(query: Query): Promise<unknown> {
    const scope = query.scope === undefined ? undefined : String(query.scope)
    const type = query.type === undefined ? undefined : String(query.type)
    // Only one brain can hold what the filters ask for: ask that one.
    const agentOnly = scope !== undefined && this.own(scope) && type !== undefined && IDENTITY_TYPES.has(type)
    const spaceOnly = (type !== undefined && !IDENTITY_TYPES.has(type)) || (scope !== undefined && !this.own(scope))
      || query.task_id !== undefined
    if (agentOnly) return this.agent.get('/list', query)
    if (spaceOnly) return this.space.get('/list', query)
    const [space, agent] = await Promise.all([this.space.get('/list', query), this.agent.get('/list', query)])
    const engrams = [...engramsOf(space), ...engramsOf(agent)]
    const order = String(query.order_by ?? 'updated_at')
    if (order === 'created_at' || order === 'updated_at') {
      engrams.sort((a, b) => String(b[order] ?? '').localeCompare(String(a[order] ?? '')))
    }
    const limit = Number(query.limit ?? 50)
    const page = engrams.slice(0, limit)
    return { count: page.length, engrams: page }
  }
}

/** The object kind of an /object/<kind>[/<id>] path, else null. */
function objectKind(path: string): string | null {
  const m = /^\/object\/([a-z]+)(?:\/|$)/.exec(path)
  return m ? m[1] : null
}

const markdownOf = (r: unknown): string => {
  const m = (r as Body | null)?.markdown
  return typeof m === 'string' ? m : ''
}

const joinMarkdown = (...parts: string[]) => parts.filter((p) => p.trim()).join('\n\n')

const engramsOf = (r: unknown): Body[] => {
  const e = (r as Body | null)?.engrams
  return Array.isArray(e) ? (e as Body[]) : []
}

/** Two recall results as one: the space's hits, then the agent brain's (core render.ts renderRecallMarkdown). */
function mergeRecall(space: Body, agent: Body): Body {
  const n = (r: Body) => (typeof r.engrams === 'number' ? r.engrams : 0)
  if (n(agent) === 0) return space
  if (n(space) === 0) return agent
  const hits = (r: Body) => markdownOf(r).split('\n').slice(1).join('\n').replace(/^\s*_\d+ engram\(s\)_\s*/, '').trim()
  const header = markdownOf(space).split('\n')[0]
  return {
    ...space,
    engrams: n(space) + n(agent),
    markdown: `${header}\n\n_${n(space) + n(agent)} engram(s)_\n\n${hits(space)}\n\n${hits(agent)}`,
  }
}
