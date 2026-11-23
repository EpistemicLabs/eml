import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SharedMcpHost, type SharedLaunch } from '../src/infrastructure/plugins/shared-mcp.js'
import { McpRelay } from '../src/infrastructure/plugins/mcp-relay.js'
import { McpOAuth } from '../src/infrastructure/plugins/mcp-oauth.js'
import { emptySpacePlugins, mcpServersFor, setPlugin, type Connection } from '../src/domain/space-plugins.js'
import { readManifest } from '../src/domain/plugin-manifest.js'

// The MCP servers the cockpit runs once for every session (shared-mcp.ts), the relay sessions reach
// them through, and the session config that points there. The server is a small fake that speaks the
// shared mode's contract; every address and key is a placeholder.

const FAKE = `
const http = require('http')
const key = process.env.EML_MCP_HTTP_KEY
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + key) { res.writeHead(401); return res.end() }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-' + process.pid })
    res.end(JSON.stringify({ pid: process.pid, mailbox: process.env.MAILBOX, body }))
  })
})
server.listen(0, '127.0.0.1', () => process.stdout.write('EML_MCP_LISTENING ' + server.address().port + '\\n'))
process.stdin.on('end', () => process.exit(0)).resume()
`

let dir: string
let script: string
const hosts: SharedMcpHost[] = []

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'shared-mcp-test-'))
  script = join(dir, 'fake-server.cjs')
  writeFileSync(script, FAKE)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => { for (const host of hosts.splice(0)) host.stopAll() })

const mailbox = (id: string, address: string): Connection => ({ id, plugin: 'gmail', label: id, values: { address, credentialsFile: '/creds.json' } })
const newHost = (keyFile = join(dir, 'shared.key')) => {
  const host = new SharedMcpHost({
    keyFile,
    launch: async (c): Promise<SharedLaunch | null> => (c.plugin === 'gmail' ? { command: process.execPath, args: [script], env: { MAILBOX: c.values.address } } : null),
  })
  hosts.push(host)
  return host
}
const ask = async (endpoint: { url: string; token: string }) => (await fetch(endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` }, body: '{}' })).json() as Promise<{ pid: number; mailbox: string }>

describe('SharedMcpHost', () => {
  it('keeps a relay key per sign-in that outlives the cockpit, in an owner-only file', () => {
    const keyFile = join(dir, 'keys', 'shared.key')
    const first = newHost(keyFile).keyFor('gmail-a')
    expect(newHost(keyFile).keyFor('gmail-a')).toBe(first)
    expect(newHost(keyFile).keyFor('gmail-b')).not.toBe(first)
    if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600)
  })

  it('runs one process per sign-in, however many ask at once', async () => {
    const host = newHost()
    const a = mailbox('gmail-a', 'me@work.example')
    const [one, two] = await Promise.all([host.endpoint(a), host.endpoint(a)])
    expect(one).toEqual(two)
    const other = await host.endpoint(mailbox('gmail-b', 'invoice@work.example'))
    expect(host.count()).toBe(2)
    const [x, y] = await Promise.all([ask(one!), ask(other!)])
    expect(x.mailbox).toBe('me@work.example')
    expect(y.mailbox).toBe('invoice@work.example')
    expect(x.pid).not.toBe(y.pid)
  })

  it('starts again when the sign-in changes or the process ended, and ends with the sign-in', async () => {
    const host = newHost()
    const first = await ask((await host.endpoint(mailbox('gmail-a', 'me@work.example')))!)
    const changed = await ask((await host.endpoint(mailbox('gmail-a', 'other@work.example')))!)
    expect(changed.pid).not.toBe(first.pid)
    expect(changed.mailbox).toBe('other@work.example')
    process.kill(changed.pid, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const again = await ask((await host.endpoint(mailbox('gmail-a', 'other@work.example')))!)
    expect(again.pid).not.toBe(changed.pid)
    host.retain([])
    expect(host.count()).toBe(0)
  })

  it('has nothing for a sign-in of a plugin without a shared part', async () => {
    expect(await newHost().endpoint({ id: 'qonto-a', plugin: 'qonto', label: 'q', values: {} })).toBeNull()
  })
})

describe('McpRelay with a shared server', () => {
  let relayServer: Server
  let relay: string
  let host: SharedMcpHost
  const connections = [mailbox('gmail-a', 'me@work.example')]

  beforeAll(async () => {
    host = new SharedMcpHost({ keyFile: join(dir, 'relay.key'), launch: async (c) => ({ command: process.execPath, args: [script], env: { MAILBOX: c.values.address } }) })
    const instance = new McpRelay({
      connections: async () => connections,
      update: async () => undefined,
      serverUrl: async () => null,
      oauth: new McpOAuth(),
      isLocal: () => true,
      shared: host,
    })
    relayServer = createServer((req, res) => { void instance.handle(req, res) })
    await new Promise<void>((resolve) => relayServer.listen(0, '127.0.0.1', resolve))
    relay = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`
  })
  afterAll(() => { relayServer.close(); host.stopAll() })

  const call = (key: string) => fetch(`${relay}/mcp-relay/gmail-a`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eml-relay-key': key }, body: '{"jsonrpc":"2.0"}' })

  it('starts the server on the first call and passes its key, never the session\'s', async () => {
    const res = await call(host.keyFor('gmail-a'))
    expect(res.status).toBe(200)
    const answer = await res.json() as { mailbox: string; pid: number; body: string }
    expect(answer).toMatchObject({ mailbox: 'me@work.example', body: '{"jsonrpc":"2.0"}' })
    expect(res.headers.get('mcp-session-id')).toBe(`s-${answer.pid}`)
  })

  it('starts it again when it ended in between', async () => {
    const before = await (await call(host.keyFor('gmail-a'))).json() as { pid: number }
    process.kill(before.pid, 'SIGKILL')
    const after = await call(host.keyFor('gmail-a'))
    expect(after.status).toBe(200)
    expect(((await after.json()) as { pid: number }).pid).not.toBe(before.pid)
  })

  it('refuses a wrong key', async () => {
    expect((await call('wrong')).status).toBe(403)
    expect((await call(host.keyFor('gmail-b'))).status).toBe(403)
  })
})

describe('mcpServersFor with a shared part', () => {
  const gmail = (() => {
    const result = readManifest({ id: 'gmail', name: 'Gmail', tier: 'official', parts: { mcp: { transport: 'stdio', shared: true, command: '${NODE}', args: ['${COCKPIT_DIST}/gmail-mcp.cjs'], env: { GMAIL_ADDRESS: { secret: 'address' }, GOOGLE_CREDENTIALS_FILE: { secret: 'credentialsFile' } } } } }, 'official')
    if (!result.ok) throw new Error(result.reason)
    return result.manifest
  })()
  const vars = { NODE: '/bin/node', COCKPIT_DIST: '/dist', RELAY: 'http://127.0.0.1:4317/mcp-relay' }
  const state = setPlugin(emptySpacePlugins(), 'main', 'gmail', { connections: ['gmail-a', 'gmail-b'] })
  const connections = [mailbox('gmail-a', 'me@work.example'), { ...mailbox('gmail-b', 'invoice@work.example'), slug: 'invoice' }]

  it('points every mailbox at the relay under its own name, so the tool names stay', () => {
    expect(mcpServersFor('main', state, [gmail], connections, vars, (id) => `key-${id}`)).toEqual({
      servers: {
        gmail: { type: 'http', url: 'http://127.0.0.1:4317/mcp-relay/gmail-a', headers: { 'x-eml-relay-key': 'key-gmail-a' } },
        'gmail-invoice': { type: 'http', url: 'http://127.0.0.1:4317/mcp-relay/gmail-b', headers: { 'x-eml-relay-key': 'key-gmail-b' } },
      },
      problems: [],
    })
  })

  it('runs it per session where the cockpit has no shared servers, and leaves out a sign-in that lacks a secret', () => {
    expect(mcpServersFor('main', state, [gmail], connections, vars).servers.gmail).toEqual({ type: 'stdio', command: '/bin/node', args: ['/dist/gmail-mcp.cjs'], env: { GMAIL_ADDRESS: 'me@work.example', GOOGLE_CREDENTIALS_FILE: '/creds.json' } })
    const broken = [{ ...connections[0], values: { address: 'me@work.example' } }, connections[1]]
    const result = mcpServersFor('main', state, [gmail], broken, vars, (id) => `key-${id}`)
    expect(Object.keys(result.servers)).toEqual(['gmail-invoice'])
    expect(result.problems).toEqual(['Gmail: the sign-in gmail-a lacks credentialsFile'])
  })
})
