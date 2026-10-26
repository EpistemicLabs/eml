import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { HttpClient, McpHttpEndpoint, Provenance } from '../src/server'

// The Streamable HTTP endpoint (http-endpoint.ts) as an embedder serves it: the
// embedder says who calls (here from test headers), the endpoint binds each MCP
// session to that caller and stamps its writes with the caller's session.

interface Seen { path: string; brain: string; session?: string; model?: string; harness?: string }

let api: http.Server
let host: http.Server
let endpoint: McpHttpEndpoint
let hostUrl: string
const seen: Seen[] = []

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

beforeAll(async () => {
  // A stand-in EML API: records who wrote, answers every write with an engram.
  api = http.createServer((req, res) => {
    const h = (n: string) => req.headers[n] as string | undefined
    seen.push({ path: req.url ?? '', brain: h('authorization') ?? '', session: h('x-eml-session'), model: h('x-eml-model'), harness: h('x-eml-harness') })
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', type: 'note' }))
    })
  })
  const apiUrl = `http://127.0.0.1:${await listen(api)}`

  endpoint = new McpHttpEndpoint({
    open: ({ owner, sessionId }) => {
      const provenance = Provenance.forSession(sessionId, async () => `model-of-${sessionId}`)
      return { client: new HttpClient({ url: apiUrl, token: `token-of-${owner}`, writeHeaders: () => provenance.headers() }), provenance }
    },
  })
  host = http.createServer((req, res) => {
    const owner = req.headers['x-test-owner'] as string
    const sessionId = req.headers['x-test-session'] as string
    void endpoint.handle(req, res, { owner, sessionId })
  })
  hostUrl = `http://127.0.0.1:${await listen(host)}/mcp`
})

afterAll(async () => {
  await endpoint.close()
  await new Promise((r) => host.close(r))
  await new Promise((r) => api.close(r))
})

async function connect(owner: string, sessionId: string, name = 'claude-code'): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(hostUrl), {
    requestInit: { headers: { 'x-test-owner': owner, 'x-test-session': sessionId } },
  })
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(transport)
  return { client, transport }
}

const note = (title: string) => ({ name: 'eml_note', arguments: { content: `note ${title}`, scope: 'global', title } })

describe('McpHttpEndpoint', () => {
  it('serves the tools and stamps a write with the caller\'s session, model and harness', async () => {
    const { client } = await connect('space-a', 'session-1')
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toContain('eml_note')

    seen.length = 0
    await client.callTool(note('one'))
    expect(seen).toEqual([{ path: '/engram/note', brain: 'Bearer token-of-space-a', session: 'session-1', model: 'model-of-session-1', harness: 'claude-code' }])
    await client.close()
  })

  it('keeps two sessions apart when they write at the same time', async () => {
    const a = await connect('space-a', 'session-a')
    const b = await connect('space-b', 'session-b')
    seen.length = 0
    await Promise.all([a.client.callTool(note('a')), b.client.callTool(note('b'))])
    const bySession = Object.fromEntries(seen.map((s) => [s.session, s.brain]))
    expect(bySession).toEqual({ 'session-a': 'Bearer token-of-space-a', 'session-b': 'Bearer token-of-space-b' })
    await a.client.close()
    await b.client.close()
  })

  it('refuses an MCP session used by another caller', async () => {
    const { client, transport } = await connect('space-a', 'session-x')
    const res = await fetch(hostUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-session-id': transport.sessionId!, 'mcp-protocol-version': '2025-06-18',
        'x-test-owner': 'space-b', 'x-test-session': 'session-x',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(403)
    await client.close()
  })

  it('asks for initialize first and forgets a closed session', async () => {
    const plain = (headers: Record<string, string>) => fetch(hostUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-test-owner': 'space-a', 'x-test-session': 's', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect((await plain({})).status).toBe(400)
    expect((await plain({ 'mcp-session-id': 'not-a-session' })).status).toBe(404)

    const before = endpoint.size
    const { client, transport } = await connect('space-a', 'session-gone')
    expect(endpoint.size).toBe(before + 1)
    await transport.terminateSession()
    await client.close()
    expect(endpoint.size).toBe(before)
  })
})
