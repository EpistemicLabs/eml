import type * as http from 'node:http'
import type { AgentBrains } from './agents.js'
import type { BrainSpaces } from './brain-space.js'
import { readBrainInfo, revealBrainFile, type BrainInfo } from './brain-info.js'
import { HANDLE, readCockpitConfig, updateCockpitConfig } from './config.js'

/**
 * The agents of this home for the UI (Settings › Agents, Settings › Brain):
 *
 *   GET  /api/agents                     → { handle, agents: [{ id, name, brainId, runtime, spaces: [{ id, name }] }] }
 *   GET  /api/agents/:id/brain/<path>    → a read of that agent's brain, as /api/brain reads a space's
 *                                          (GET only: an agent writes its own identity in a session;
 *                                          the brain token stays in the host)
 *   POST /api/agent-upgrade/handle       → { handle }: the home's human when the agent upgrade could
 *                                          not tell it; taken only while the config has none; the
 *                                          upgrade then runs at the next start
 *   POST /api/agent-upgrade/reveal       → opens the report folder of the active space's upgrade state
 */

type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>

export interface AgentsApiDeps {
  agents: AgentBrains
  spaces: BrainSpaces
  /** Who is in a brain, by its token (brain-info.ts); tests pass a stand-in. */
  info?: (token: string) => Pick<BrainInfo, 'agents' | 'users'>
  reveal?: (file: string) => Promise<void>
}

const BRAIN_PREFIX = /^\/api\/agents\/([^/]+)\/brain(\/.*)?$/

export async function handleAgentsApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentsApiDeps,
  pathname: string,
  method: string,
  json: Json,
  readJson: ReadJson,
): Promise<boolean> {
  if (pathname === '/api/agents' && method === 'GET') {
    const config = await readCockpitConfig()
    const info = deps.info ?? readBrainInfo
    const agents = deps.agents.list().map((agent) => ({
      id: agent.id,
      name: info(agent.token).agents.find((a) => a.id === agent.id)?.name ?? agent.id,
      brainId: agent.brainId,
      runtime: deps.agents.expectsRuntime(agent.id),
      spaces: deps.spaces.list().filter((s) => s.agent === agent.id).map((s) => ({ id: s.id, name: s.name })),
    }))
    json(res, 200, { handle: config?.handle ?? null, agents })
    return true
  }

  const brain = BRAIN_PREFIX.exec(pathname)
  if (brain) {
    if (method !== 'GET') { json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'An agent brain is read here; the agent writes it in a session.' } }); return true }
    const agent = deps.agents.get(decodeURIComponent(brain[1]))
    if (!agent) { json(res, 404, { error: { code: 'NO_SUCH_AGENT', message: 'No such agent' } }); return true }
    const query = (req.url ?? '').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?')) : ''
    const rel = `${brain[2] || '/'}${query}`
    try {
      const upstream = await fetch(`${agent.url}${rel}`, { headers: { Authorization: `Bearer ${agent.token}`, Accept: 'application/json' } })
      const text = await upstream.text()
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' })
      res.end(text)
    } catch {
      json(res, 502, { error: 'Failed to reach the brain API.' })
    }
    return true
  }

  if (pathname === '/api/agent-upgrade/handle' && method === 'POST') {
    const body = await readJson(req)
    const handle = typeof body.handle === 'string' ? body.handle.trim() : ''
    if (!HANDLE.test(handle)) {
      json(res, 400, { error: { code: 'INVALID_INPUT', message: 'A handle is 1–63 characters of a-z, 0-9, _ and -.' } })
      return true
    }
    const written = await updateCockpitConfig((config) => {
      if (!config) throw new Error('no cockpit config')
      if (config.handle) return null
      return { ...config, handle }
    })
    if (!written) { json(res, 409, { error: { code: 'HANDLE_SET', message: 'This cockpit has its handle already.' } }); return true }
    json(res, 200, { handle, restart: true })
    return true
  }

  if (pathname === '/api/agent-upgrade/reveal' && method === 'POST') {
    const space = deps.spaces.fromHeader(req.headers['x-cockpit-space'])
    const report = space?.upgrade?.report
    if (!report) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'No upgrade report for this space' } }); return true }
    await (deps.reveal ?? revealBrainFile)(report)
    json(res, 200, { success: true })
    return true
  }

  return false
}
