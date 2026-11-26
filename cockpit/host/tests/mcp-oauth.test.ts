import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { McpOAuth, oauthValuesOf } from '../src/infrastructure/plugins/mcp-oauth.js'
import { McpRelay, stringValues } from '../src/infrastructure/plugins/mcp-relay.js'
import { emptySpacePlugins, mcpServersFor, setPlugin, type Connection } from '../src/domain/space-plugins.js'
import { readManifest } from '../src/domain/plugin-manifest.js'

// Signing in to a remote MCP server with OAuth (mcp-oauth.ts) and the relay sessions reach it
// through (mcp-relay.ts), against a local fake of an MCP server with its own OAuth service. Every
// token here is a placeholder.

let server: Server
let base: string
const registered: Array<Record<string, unknown>> = []
const tokenForms: URLSearchParams[] = []
const seen: Array<{ method: string; authorization?: string; session?: string; body: string }> = []
const keyed: Array<{ apiKey?: string; authorization?: string }> = []
const revoked: URLSearchParams[] = []
let validToken = 'access-1'
let refreshAnswer: 'ok' | 'refused' = 'ok'
let verifierChallenge = ''

const read = (req: IncomingMessage) => new Promise<string>((resolve) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => resolve(b)) })

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)
    const body = await read(req)
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/mcp') {
      seen.push({ method: req.method ?? '', authorization: req.headers.authorization, session: req.headers['mcp-session-id'] as string | undefined, body })
      if (req.headers.authorization !== `Bearer ${validToken}`) return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
      return json(200, { jsonrpc: '2.0', id: 1, result: { ok: true } }, { 'mcp-session-id': 'session-1' })
    }
    if (url.pathname === '/keyed') {
      keyed.push({ apiKey: req.headers['x-api-key'] as string | undefined, authorization: req.headers.authorization })
      return json(req.headers['x-api-key'] === 'secret-key' ? 200 : 401, { jsonrpc: '2.0', id: 1, result: { ok: true } })
    }
    if (url.pathname === '/auth/revoke') { revoked.push(new URLSearchParams(body)); return json(200, {}) }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/auth`], scopes_supported: ['offline_access', 'read'] })
    if (url.pathname === '/.well-known/oauth-authorization-server/auth') return json(200, { authorization_endpoint: `${base}/auth/authorize`, token_endpoint: `${base}/auth/token`, registration_endpoint: `${base}/auth/register`, revocation_endpoint: `${base}/auth/revoke` })
    if (url.pathname === '/auth/register') { registered.push(JSON.parse(body)); return json(201, { client_id: 'client-1' }) }
    if (url.pathname === '/auth/token') {
      const form = new URLSearchParams(body)
      tokenForms.push(form)
      if (form.get('grant_type') === 'authorization_code') {
        if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== verifierChallenge) return json(400, { error: 'invalid_grant' })
        return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 })
      }
      if (refreshAnswer === 'refused') return json(400, { error: 'invalid_grant' })
      return json(200, { access_token: validToken, expires_in: 3600 })
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.close() })
beforeEach(() => { registered.length = 0; tokenForms.length = 0; seen.length = 0; keyed.length = 0; revoked.length = 0; validToken = 'access-1'; refreshAnswer = 'ok' })

describe('McpOAuth', () => {
  it('finds the sign-in service from the 401, registers the cockpit for its callback and trades the code with PKCE', async () => {
    const oauth = new McpOAuth()
    const started = await oauth.start(`${base}/mcp`, 'https://cockpit.example/api/plugins/oauth/callback')
    if (!started.ok) throw new Error(started.reason)
    expect(registered[0]).toMatchObject({ redirect_uris: ['https://cockpit.example/api/plugins/oauth/callback'], token_endpoint_auth_method: 'none' })
    const consent = new URL(started.url)
    expect(consent.origin + consent.pathname).toBe(`${base}/auth/authorize`)
    expect(Object.fromEntries(consent.searchParams)).toMatchObject({ client_id: 'client-1', code_challenge_method: 'S256', resource: `${base}/mcp`, scope: 'offline_access read', state: started.state })
    verifierChallenge = consent.searchParams.get('code_challenge') ?? ''
    const finished = await oauth.finish(started.state, 'code-1')
    if (!finished.ok) throw new Error(finished.reason)
    expect(finished.values).toMatchObject({ tokenEndpoint: `${base}/auth/token`, revocationEndpoint: `${base}/auth/revoke`, clientId: 'client-1', resource: `${base}/mcp`, accessToken: 'access-1', refreshToken: 'refresh-1' })
    expect(oauth.knows(started.state)).toBe(false)
    expect((await oauth.finish(started.state, 'code-1')).ok).toBe(false)
  })

  it('revokes a removed sign-in\'s refresh token where the server names a revocation endpoint (RFC 7009)', async () => {
    const oauth = new McpOAuth()
    const values = { tokenEndpoint: `${base}/auth/token`, clientId: 'client-1', resource: `${base}/mcp`, accessToken: 'access-1', refreshToken: 'refresh-1' }
    expect(await oauth.revoke(values)).toBe(false)
    expect(await oauth.revoke({ ...values, revocationEndpoint: `${base}/auth/revoke` })).toBe(true)
    expect(Object.fromEntries(revoked[0])).toEqual({ token: 'refresh-1', token_type_hint: 'refresh_token', client_id: 'client-1' })
  })

  it('says why a server without OAuth metadata or registration cannot be signed in to', async () => {
    const refused = await new McpOAuth().start(`${base}/nothing-here`, 'https://cockpit.example/cb')
    expect(refused).toMatchObject({ ok: false, retryable: false })
  })
})

describe('McpRelay', () => {
  const values = { tokenEndpoint: '', clientId: 'client-1', resource: '', accessToken: 'access-1', refreshToken: 'refresh-1', relayKey: 'key-1' }
  let connections: Connection[]
  let relayServer: Server
  let relay: string
  let local = true
  let refusedTold: string[] = []
  let instance: McpRelay

  beforeAll(async () => {
    instance = new McpRelay({
      connections: async () => connections,
      update: async (id, change) => { connections = connections.map((c) => (c.id === id ? change(c) : c)) },
      server: async (plugin) => plugin === 'qonto'
        ? { transport: 'http', url: `${base}/mcp`, headers: {} }
        : plugin === 'keyed' ? { transport: 'http', url: `${base}/keyed`, headers: { 'X-Api-Key': { secret: 'apiKey' } } } : null,
      oauth: new McpOAuth(),
      isLocal: () => local,
      onRefused: (c) => { refusedTold.push(c.id) },
    })
    relayServer = createServer((req, res) => { void instance.handle(req, res) })
    await new Promise<void>((resolve) => relayServer.listen(0, '127.0.0.1', resolve))
    relay = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`
  })
  afterAll(() => { relayServer.close() })
  beforeEach(() => {
    local = true
    refusedTold = []
    connections = [{ id: 'qonto-a', plugin: 'qonto', label: 'Company A', values: { ...values, tokenEndpoint: `${base}/auth/token`, resource: `${base}/mcp` } }]
  })

  const call = (key = 'key-1', id = 'qonto-a') => fetch(`${relay}/mcp-relay/${id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-eml-relay-key': key, 'mcp-session-id': 'session-1', cookie: 'not-forwarded' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  })

  it('adds the sign-in\'s token and passes the session id both ways, nothing else', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toBe('session-1')
    expect(seen).toEqual([{ method: 'POST', authorization: 'Bearer access-1', session: 'session-1', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }])
  })

  it('renews a token the server refuses and keeps the new one', async () => {
    validToken = 'access-2'
    const res = await call()
    expect(res.status).toBe(200)
    expect(tokenForms.at(-1)?.get('grant_type')).toBe('refresh_token')
    expect(oauthValuesOf(connections[0].values)?.accessToken).toBe('access-2')
    expect(connections[0].values.refreshToken).toBe('refresh-1')
  })

  it('marks the sign-in for signing in again when the renewal is refused', async () => {
    validToken = 'access-2'
    refreshAnswer = 'refused'
    const res = await call()
    expect(res.status).toBe(401)
    expect((await res.json()).error.message).toContain('sign in again')
    expect(connections[0].signInNeeded).toBe(true)
    expect(refusedTold).toEqual(['qonto-a'])
    // Refused again: already marked, so nobody is told twice.
    expect((await call()).status).toBe(401)
    expect(refusedTold).toEqual(['qonto-a'])
  })

  it('notes the renewal and the use on the sign-in', async () => {
    validToken = 'access-2'
    expect((await call()).status).toBe(200)
    expect(connections[0].renewedAt).toMatch(/^\d{4}-/)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(connections[0].usedAt).toMatch(/^\d{4}-/)
  })

  it('renews ahead of use a sign-in that runs out soon, and leaves one that is still good', async () => {
    connections = [
      { ...connections[0], id: 'qonto-soon', values: { ...connections[0].values, expiresAt: String(Date.now() + 60_000) } },
      { ...connections[0], id: 'qonto-later', values: { ...connections[0].values, expiresAt: String(Date.now() + 3600_000) } },
    ]
    validToken = 'access-3'
    expect(await instance.renewDue()).toEqual({ 'qonto-soon': 'renewed' })
    expect(connections[0].values.accessToken).toBe('access-3')
    expect(connections[1].values.accessToken).toBe('access-1')
  })

  it('fills a static secret into the server\'s header, so the session never holds it', async () => {
    connections = [{ id: 'keyed-a', plugin: 'keyed', label: 'Keyed', values: { apiKey: 'secret-key', relayKey: 'key-k' } }]
    const res = await call('key-k', 'keyed-a')
    expect(res.status).toBe(200)
    expect(keyed).toEqual([{ apiKey: 'secret-key', authorization: undefined }])
  })

  it('passes the session\'s query along to a static-secret server', async () => {
    connections = [{ id: 'keyed-a', plugin: 'keyed', label: 'Keyed', values: { apiKey: 'secret-key', relayKey: 'key-k' } }]
    const res = await fetch(`${relay}/mcp-relay/keyed-a?page=2`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eml-relay-key': 'key-k' }, body: '{}' })
    expect(res.status).toBe(200)
  })

  it('refuses a wrong key, an unknown sign-in and anything not from this machine', async () => {
    expect((await call('wrong-key')).status).toBe(403)
    expect((await call('key-1', 'qonto-b')).status).toBe(403)
    local = false
    expect((await call()).status).toBe(403)
    expect(seen).toEqual([])
  })
})

describe('mcpServersFor with an OAuth sign-in', () => {
  const qonto = (() => {
    const result = readManifest({ id: 'qonto', name: 'Qonto', tier: 'custom', parts: { mcp: { transport: 'http', url: 'https://mcp.qonto.example/mcp', headers: {} } }, auth: { kind: 'mcp-oauth' } }, 'custom')
    if (!result.ok) throw new Error(result.reason)
    return result.manifest
  })()
  const vars = { RELAY: 'http://127.0.0.1:4317/mcp-relay' }
  const signIn = (id: string, slug?: string): Connection => ({ id, plugin: 'qonto', label: id, ...(slug ? { slug } : {}), values: { ...stringValues({ tokenEndpoint: 't', clientId: 'c', resource: 'r', accessToken: 'a' }), relayKey: `key-${id}` } })

  it('points each picked sign-in at the relay with its key, under the plugin\'s name or its short name', () => {
    let state = setPlugin(emptySpacePlugins(), 'main', 'qonto', { connections: ['qonto-a'] })
    state = setPlugin(state, 'sachi', 'qonto', { connections: ['qonto-b'] })
    const connections = [signIn('qonto-a'), signIn('qonto-b', 'b')]
    expect(mcpServersFor('main', state, [qonto], connections, vars).servers).toEqual({ qonto: { type: 'http', url: 'http://127.0.0.1:4317/mcp-relay/qonto-a', headers: { 'x-eml-relay-key': 'key-qonto-a' } } })
    expect(mcpServersFor('sachi', state, [qonto], connections, vars).servers).toEqual({ 'qonto-b': { type: 'http', url: 'http://127.0.0.1:4317/mcp-relay/qonto-b', headers: { 'x-eml-relay-key': 'key-qonto-b' } } })
  })

  it('leaves the server out of a space without a sign-in and says so, instead of a direct entry nobody signed in to', () => {
    const state = setPlugin(emptySpacePlugins(), 'main', 'qonto', { connections: [] })
    expect(mcpServersFor('main', state, [qonto], [], vars)).toEqual({ servers: {}, problems: ['Qonto: no sign-in picked for this space'] })
  })
})
