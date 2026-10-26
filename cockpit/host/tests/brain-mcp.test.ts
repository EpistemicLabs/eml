import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createBrainMcpHandler, type BrainMcpDeps } from '../src/brain-mcp.js'
import type { BrainSpace, BrainSpaces } from '../src/brain-space.js'

// Who may use the host's brain MCP endpoint (brain-mcp.ts): this machine only,
// with a space's MCP token, and a session the ledger knows in that space.

const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

const space = (id: string, ledgerKey: string | null, mcpToken: string, url: string) =>
  ({ id, ledgerKey, mcpToken, url, token: `brain-token-${id}`, registry: { get: () => undefined } }) as unknown as BrainSpace

let brain: http.Server
let host: http.Server
let mcpUrl: string
let close: () => Promise<void>
const brainCalls: string[] = []

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

beforeAll(async () => {
  brain = http.createServer((req, res) => {
    brainCalls.push(`${req.headers.authorization} ${req.headers['x-eml-session']}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  const brainUrl = `http://127.0.0.1:${await listen(brain)}`
  const main = space('brain-main', null, TOKEN_A, brainUrl)
  const other = space('brain-other', 'brain-other', TOKEN_B, brainUrl)
  const spaces = {
    get: (id: string) => [main, other].find((s) => s.id === id),
    resolve: () => main,
    byMcpToken: (t: string | undefined) => [main, other].find((s) => s.mcpToken === t) ?? null,
  } as unknown as BrainSpaces
  const ledger = new Map<string, { spaceId: string | null; projectId: string | null }>([
    ['session-main', { spaceId: null, projectId: null }],
    ['session-other', { spaceId: 'brain-other', projectId: null }],
  ])
  const deps: BrainMcpDeps = {
    spaces,
    ledger: { get: (id: string) => ledger.get(id), ref: () => ({}) } as unknown as BrainMcpDeps['ledger'],
    providers: { forSession: () => ({ summary: () => ({ model: 'claude-test' }) }) } as unknown as BrainMcpDeps['providers'],
  }
  const handler = createBrainMcpHandler(deps)
  close = () => handler.close()
  host = http.createServer((req, res) => { void handler.handle(req, res) })
  mcpUrl = `http://127.0.0.1:${await listen(host)}/mcp`
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
    expect((await post({ 'x-cockpit-mcp-token': 'c'.repeat(64), 'x-eml-session': 'session-main' })).status).toBe(403)
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

  it('never reaches the brain for a refused request', () => {
    expect(brainCalls).toEqual([])
  })
})
