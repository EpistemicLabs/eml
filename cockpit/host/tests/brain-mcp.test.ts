import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createBrainMcpHandler, type BrainMcpDeps } from '../src/brain-mcp.js'
import { AgentBrains } from '../src/agents.js'
import type { BrainSpace, BrainSpaces } from '../src/brain-space.js'

// Who may use the host's brain MCP endpoint and hook routes (brain-mcp.ts):
// this machine only, with a space's MCP token, and — on the endpoint — a
// session the ledger knows in that space. What a session then gets: its
// space's brain and the bound agent's, routed by scope, every write stamped
// with the agent.

const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)
const TOKEN_C = 'c'.repeat(64)

const space = (id: string, name: string, agent: string | null, ledgerKey: string | null, mcpToken: string, url: string) =>
  ({ id, name, agent, ledgerKey, mcpToken, url, token: `brain-token-${id}`, registry: { get: () => undefined } }) as unknown as BrainSpace

interface Seen { auth?: string; method?: string; path: string; agent?: string; session?: string; body: Record<string, unknown> }

let brain: http.Server
let host: http.Server
let mcpUrl: string
let hooksUrl: string
let close: () => Promise<void>
const seen: Seen[] = []

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

beforeAll(async () => {
  // A stand-in brain server: records every call with its bearer, answers by route.
  brain = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const h = (n: string) => req.headers[n] as string | undefined
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      const path = req.url ?? ''
      seen.push({ auth: h('authorization'), method: req.method, path, agent: h('x-eml-agent'), session: h('x-eml-session'), body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (path === '/boot') res.end(JSON.stringify({ markdown: body.part === 'system' ? '## EML System Rules\n- rule' : `# EML Boot — ${body.agent}\n- persona`, budget: { limit: body.budget ?? 0, chars: 10, fits: true, situational_title_only: 0 } }))
      else if (path.startsWith('/list')) res.end(JSON.stringify({ count: 0, engrams: [] }))
      else res.end(JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', type: 'note' }))
    })
  })
  const brainUrl = `http://127.0.0.1:${await listen(brain)}`
  const main = space('brain-main', 'Main', 'atlas', null, TOKEN_A, brainUrl)
  const other = space('brain-other', 'Life', 'atlas', 'brain-other', TOKEN_B, brainUrl)
  const unbound = space('brain-unbound', 'Legacy', null, 'brain-unbound', TOKEN_C, brainUrl)
  const all = [main, other, unbound]
  const spaces = {
    get: (id: string) => all.find((s) => s.id === id),
    resolve: () => main,
    byMcpToken: (t: string | undefined) => all.find((s) => s.mcpToken === t) ?? null,
  } as unknown as BrainSpaces
  const ledger = new Map<string, { spaceId: string | null; projectId: string | null }>([
    ['session-main', { spaceId: null, projectId: null }],
    ['session-other', { spaceId: 'brain-other', projectId: null }],
    ['session-unbound', { spaceId: 'brain-unbound', projectId: null }],
  ])
  const deps: BrainMcpDeps = {
    spaces,
    agents: new AgentBrains([{ id: 'atlas', brainId: 'brain-atlas', url: brainUrl, token: 'brain-token-atlas' }]),
    ledger: { get: (id: string) => ledger.get(id), ref: () => ({}) } as unknown as BrainMcpDeps['ledger'],
    providers: { forSession: () => ({ summary: () => ({ model: 'claude-test' }) }) } as unknown as BrainMcpDeps['providers'],
  }
  const handler = createBrainMcpHandler(deps)
  close = () => handler.close()
  host = http.createServer((req, res) => {
    if (req.url?.startsWith('/hooks/')) void handler.handleHooks(req, res)
    else void handler.handle(req, res)
  })
  const port = await listen(host)
  mcpUrl = `http://127.0.0.1:${port}/mcp`
  hooksUrl = `http://127.0.0.1:${port}/hooks`
})

afterAll(async () => {
  await close()
  await new Promise((r) => host.close(r))
  await new Promise((r) => brain.close(r))
})

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } } }

function post(headers: Record<string, string>, body: unknown = initialize) {
  return fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
}

describe('brain MCP endpoint access', () => {
  it('opens an MCP session for a known session with its space\'s token', async () => {
    const res = await post({ 'x-cockpit-mcp-token': TOKEN_A, 'x-eml-session': 'session-main' })
    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toBeTruthy()
    await res.text()
  })

  it('refuses a missing or unknown token', async () => {
    expect((await post({ 'x-eml-session': 'session-main' })).status).toBe(403)
    expect((await post({ 'x-cockpit-mcp-token': 'd'.repeat(64), 'x-eml-session': 'session-main' })).status).toBe(403)
  })

  it('refuses a session the ledger does not know, or one of another space', async () => {
    expect((await post({ 'x-cockpit-mcp-token': TOKEN_A })).status).toBe(403)
    expect((await post({ 'x-cockpit-mcp-token': TOKEN_A, 'x-eml-session': 'session-unknown' })).status).toBe(403)
    // A session of the other space with main's token, and the reverse: never another brain.
    expect((await post({ 'x-cockpit-mcp-token': TOKEN_A, 'x-eml-session': 'session-other' })).status).toBe(403)
    expect((await post({ 'x-cockpit-mcp-token': TOKEN_B, 'x-eml-session': 'session-main' })).status).toBe(403)
  })

  it('refuses a proxied request even with a valid token and session (remote access)', async () => {
    const ok = { 'x-cockpit-mcp-token': TOKEN_A, 'x-eml-session': 'session-main' }
    expect((await post({ ...ok, 'x-forwarded-for': '100.64.0.2' })).status).toBe(403)
    expect((await post({ ...ok, 'tailscale-user-login': 'someone@example.com' })).status).toBe(403)
  })

  it('refuses a space without a bound agent, and says so', async () => {
    const res = await post({ 'x-cockpit-mcp-token': TOKEN_C, 'x-eml-session': 'session-unbound' })
    expect(res.status).toBe(403)
    expect((await res.json()).error.message).toBe('Space "Legacy" has no agent bound — its sessions get no brain until an agent is bound to it.')
  })

  it('never reaches a brain for a refused request', () => {
    expect(seen).toEqual([])
  })
})

describe('what a session gets through the endpoint', () => {
  async function call(sessionId: string, token: string, name: string, args: Record<string, unknown>) {
    const init = await post({ 'x-cockpit-mcp-token': token, 'x-eml-session': sessionId })
    const mcpSession = init.headers.get('mcp-session-id') as string
    await init.text()
    const headers = { 'x-cockpit-mcp-token': token, 'x-eml-session': sessionId, 'mcp-session-id': mcpSession }
    await post(headers, { jsonrpc: '2.0', method: 'notifications/initialized' })
    const res = await post(headers, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
    return res.text()
  }

  it('routes a rule in the agent\'s scope to the agent brain and a note to the space, each stamped with the agent', async () => {
    seen.length = 0
    await call('session-other', TOKEN_B, 'eml_rule', { content: 'be brief', scope: 'agent.atlas', title: 'brevity', applies: 'always', why: 'w', agreed: 'yes' })
    await call('session-other', TOKEN_B, 'eml_note', { content: 'a note', scope: 'user.alex', title: 'n' })
    const writes = seen.filter((s) => s.method === 'POST' && s.path.startsWith('/engram/'))
    expect(writes.map((s) => [s.path, s.auth, s.agent, s.session])).toEqual([
      ['/engram/rule', 'Bearer brain-token-atlas', 'atlas', 'session-other'],
      ['/engram/note', 'Bearer brain-token-brain-other', 'atlas', 'session-other'],
    ])
  })
})

describe('hook routes', () => {
  const hook = (path: string, token: string | null, body?: unknown) => fetch(`${hooksUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  it('composes the boot: the agent part from the agent brain within what the system rules leave, the system rules from the space', async () => {
    seen.length = 0
    const res = await hook('/boot', TOKEN_A, { budget: 9999 })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.markdown).toBe('# EML Boot — atlas\n- persona\n\n## EML System Rules\n- rule')
    expect(body.budget).toMatchObject({ limit: 9999, chars: body.markdown.length, fits: true })
    expect(seen.map((s) => [s.path, s.auth, s.body.part, s.body.budget])).toEqual([
      ['/boot', 'Bearer brain-token-brain-main', 'system', undefined],
      ['/boot', 'Bearer brain-token-atlas', 'identity', 9999 - '## EML System Rules\n- rule'.length - 2],
    ])
  })

  it('proxies the reads the hooks make (project block, list) to the space with the query as given', async () => {
    seen.length = 0
    expect((await hook('/project-block', TOKEN_A, { scope: 'project.demo', budget: 100 })).status).toBe(200)
    expect((await hook('/list?scope=project.demo&type=note&limit=5', TOKEN_A)).status).toBe(200)
    expect(seen.map((s) => [s.method, s.path, s.auth])).toEqual([
      ['POST', '/project-block', 'Bearer brain-token-brain-main'],
      ['GET', '/list?scope=project.demo&type=note&limit=5', 'Bearer brain-token-brain-main'],
    ])
    expect(seen[0].body).toEqual({ scope: 'project.demo', budget: 100 })
  })

  it('refuses a bad token (403), a space without an agent (503, with the reason), an unknown route and a bad body', async () => {
    seen.length = 0
    expect((await hook('/boot', null, {})).status).toBe(403)
    expect((await hook('/boot', 'd'.repeat(64), {})).status).toBe(403)
    const unbound = await hook('/boot', TOKEN_C, { budget: 100 })
    expect(unbound.status).toBe(503)
    expect((await unbound.json()).error).toMatch(/Space "Legacy" has no agent bound/)
    expect((await hook('/relate', TOKEN_A, {})).status).toBe(404)
    expect((await hook('/engram/x', TOKEN_A)).status).toBe(404)
    expect((await fetch(`${hooksUrl}/boot`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN_A}` }, body: 'not json' })).status).toBe(400)
    expect(seen).toEqual([])
  })
})
