import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, type PluginManifest } from '../src/domain/plugin-manifest.js'
import { deniedFor, emptySpacePlugins, mcpServersFor, setOutsideServer, setPlugin } from '../src/domain/space-plugins.js'
import { PluginRegistry } from '../src/infrastructure/plugins/plugin-registry.js'
import { PluginStore } from '../src/infrastructure/plugins/plugin-store.js'
import { importMcpServers, splitDefinition } from '../src/infrastructure/plugins/mcp-import.js'
import { parseMcpList } from '../src/infrastructure/plugins/outside-servers.js'
import { codexPluginArgs, codexPluginTables } from '../src/infrastructure/providers/codex/plugin-servers.js'
import { SpacePluginService } from '../src/application/space-plugins.js'

// Plugins per space (domain/space-plugins.ts, application/space-plugins.ts): what each space's
// session files get, the one-time import of the servers configured outside the plugins, and Codex.
// Every value here is a placeholder.

const manifest = (raw: unknown): PluginManifest => {
  const result = readManifest(raw, 'custom')
  if (!result.ok) throw new Error(result.reason)
  return result.manifest
}
const lookup = manifest({ id: 'lookup', name: 'Lookup', tier: 'custom', parts: { mcp: { transport: 'stdio', command: 'lookup-mcp', args: ['--token', { secret: 'arg:1' }], env: { KEY: { secret: 'key' }, MODE: 'fast' } } } })
const remote = manifest({ id: 'remote', name: 'Remote', tier: 'custom', parts: { mcp: { transport: 'http', serverName: 'Remote_Server', url: 'https://mcp.example.com/mcp', headers: {} } } })

describe('mcpServersFor', () => {
  it('fills the secrets from the connection the space picked and names a server by its server name', () => {
    let state = setPlugin(emptySpacePlugins(), 'a', 'lookup', { connections: ['c1'] })
    state = setPlugin(state, 'a', 'remote', { connections: [] })
    const connections = [{ id: 'c1', plugin: 'lookup', label: 'x', values: { key: 'placeholder-key', 'arg:1': 'placeholder-token' } }]
    const { servers, problems } = mcpServersFor('a', state, [lookup, remote], connections)
    expect(problems).toEqual([])
    expect(servers).toEqual({
      lookup: { type: 'stdio', command: 'lookup-mcp', args: ['--token', 'placeholder-token'], env: { KEY: 'placeholder-key', MODE: 'fast' } },
      Remote_Server: { type: 'http', url: 'https://mcp.example.com/mcp', headers: {} },
    })
    expect(mcpServersFor('b', state, [lookup, remote], connections).servers).toEqual({})
  })

  it('leaves out a server whose secret is missing, or whose mcp part is off, saying why without values', () => {
    const state = setPlugin(emptySpacePlugins(), 'a', 'lookup', { connections: [] })
    expect(mcpServersFor('a', state, [lookup], [])).toEqual({ servers: {}, problems: ['Lookup: no sign-in picked for this space'] })
    const off = { ...setPlugin(emptySpacePlugins(), 'a', 'remote', { connections: [] }), partsOff: { remote: ['mcp' as const] } }
    expect(mcpServersFor('a', off, [remote], []).servers).toEqual({})
  })

  it('lists the outside servers switched off in a space', () => {
    let state = setOutsideServer(emptySpacePlugins(), 'a', 'claude.ai Slack', false)
    state = setOutsideServer(state, 'a', 'claude.ai Drive', false)
    state = setOutsideServer(state, 'a', 'claude.ai Drive', true)
    expect(deniedFor('a', state)).toEqual(['claude.ai Slack'])
    expect(deniedFor('b', state)).toEqual([])
  })
})

describe('splitDefinition', () => {
  it('moves env and header values, a keyed URL and token arguments into the values', () => {
    const stdio = splitDefinition({ command: 'npx', args: ['-y', 'some-mcp', '--api-key', 'placeholder-1', '--mode=fast'], env: { A: 'placeholder-2' } })
    expect(stdio?.part).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', 'some-mcp', '--api-key', { secret: 'arg:3' }, '--mode=fast'], env: { A: { secret: 'env:A' } } })
    expect(stdio?.values).toEqual({ 'arg:3': 'placeholder-1', 'env:A': 'placeholder-2' })
    const http = splitDefinition({ type: 'http', url: 'https://mcp.example.com/mcp?key=placeholder-3', headers: { Authorization: 'Bearer placeholder-4' } })
    expect(http?.part).toEqual({ transport: 'http', url: { secret: 'url' }, headers: { Authorization: { secret: 'header:Authorization' } } })
    expect(splitDefinition({ type: 'http', url: 'https://mcp.example.com/mcp' })?.part).toMatchObject({ url: 'https://mcp.example.com/mcp' })
    expect(splitDefinition({ type: 'weird' })).toBeNull()
  })
})

describe('importMcpServers', () => {
  let dir: string
  let registry: PluginRegistry
  let store: PluginStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cockpit-mcp-import-'))
    mkdirSync(join(dir, 'official', 'gmail'), { recursive: true })
    writeFileSync(join(dir, 'official', 'gmail', 'plugin.json'), JSON.stringify({ id: 'gmail', name: 'Gmail', tier: 'official', parts: { channel: { adapter: 'gmail' } } }))
    registry = new PluginRegistry({ officialDir: join(dir, 'official'), customFile: join(dir, 'plugins', 'custom.json') })
    store = new PluginStore(join(dir, 'plugins'))
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({
      theme: 'auto',
      mcpServers: {
        gmail: { type: 'http', url: 'http://127.0.0.1:8765/mcp', headers: { 'X-Key': 'placeholder-a' } },
        stripe: { command: 'npx', args: ['-y', 'stripe-mcp'], env: { STRIPE_KEY: 'placeholder-b' } },
        broken: { type: 'pigeon' },
      },
    }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const spaces = [
    { id: 'main', agent: 'atlas', ownRuntime: false },
    { id: 'shared', agent: 'atlas', ownRuntime: false },
    { id: 'sachi-space', agent: 'sachi', ownRuntime: true },
  ]
  const source = () => ({
    claudeJson: join(dir, '.claude.json'),
    agents: [{ id: 'sachi', allowed: ['qonto'], definitions: { qonto: { command: 'qonto-mcp', env: { QONTO_KEY: 'placeholder-c' } }, unused: { command: 'x' } } }],
  })

  it('makes each server a custom plugin on in the spaces that load it today, secrets in the owner-only store', async () => {
    const result = await importMcpServers(source(), spaces, { registry, store, backupsDir: join(dir, 'plugins', 'backups') })
    expect(result.imported).toEqual([
      { plugin: 'gmail-claude-config', serverName: 'gmail', spaces: ['main', 'shared'] },
      { plugin: 'stripe', serverName: 'stripe', spaces: ['main', 'shared'] },
      { plugin: 'qonto', serverName: 'qonto', spaces: ['sachi-space'] },
    ])
    expect(result.skipped).toEqual([{ serverName: 'broken', reason: expect.any(String) }])
    expect((await store.spaces()).imported).toEqual(['gmail-claude-config', 'stripe', 'qonto'])
    // No value in the manifests; all of them in connections.json, owner-only.
    const custom = readFileSync(join(dir, 'plugins', 'custom.json'), 'utf8')
    expect(custom).not.toMatch(/placeholder/)
    expect(JSON.parse(custom).plugins[0].parts.mcp).toMatchObject({ serverName: 'gmail' })
    expect(readFileSync(join(dir, 'plugins', 'connections.json'), 'utf8')).toMatch(/placeholder-a/)
    expect(statSync(join(dir, 'plugins', 'connections.json')).mode & 0o777).toBe(0o600)
    // The config keeps what couldn't be imported, and everything else it had; a backup holds the rest.
    const left = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))
    expect(left).toEqual({ theme: 'auto', mcpServers: { broken: { type: 'pigeon' } } })
    expect(JSON.parse(readFileSync(result.backup ?? '', 'utf8')).mcpServers.stripe).toBeDefined()
    expect(statSync(result.backup ?? '').mode & 0o777).toBe(0o600)
    // The space's mcp.json gets the same servers under the same names as before.
    const service = new SpacePluginService(registry, store)
    const files = (await service.snapshot()).filesFor('main')
    expect(Object.keys(files.mcpServers).sort()).toEqual(['gmail', 'stripe'])
    expect(files.mcpServers.stripe).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'stripe-mcp'], env: { STRIPE_KEY: 'placeholder-b' } })
    expect(Object.keys((await service.snapshot()).filesFor('sachi-space').mcpServers)).toEqual(['qonto'])
  })

  it('changes nothing when it runs again', async () => {
    await importMcpServers(source(), spaces, { registry, store, backupsDir: join(dir, 'plugins', 'backups') })
    const before = ['custom.json', 'connections.json', 'spaces.json'].map((f) => readFileSync(join(dir, 'plugins', f), 'utf8'))
    const again = await importMcpServers(source(), spaces, { registry, store, backupsDir: join(dir, 'plugins', 'backups') })
    expect(again).toEqual({ imported: [], skipped: [], backup: null })
    expect(['custom.json', 'connections.json', 'spaces.json'].map((f) => readFileSync(join(dir, 'plugins', f), 'utf8'))).toEqual(before)
    expect(readdirSync(join(dir, 'plugins', 'backups'))).toHaveLength(1)
  })
})

describe('SpacePluginService.setup', () => {
  it('carries the cockpit-wide switches of before over to every space, once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-space-setup-'))
    try {
      mkdirSync(join(dir, 'official', 'time'), { recursive: true })
      writeFileSync(join(dir, 'official', 'time', 'plugin.json'), JSON.stringify({ id: 'time', name: 'Time', tier: 'official', parts: { pane: { builtin: 'time' } } }))
      mkdirSync(join(dir, 'official', 'note'), { recursive: true })
      writeFileSync(join(dir, 'official', 'note', 'plugin.json'), JSON.stringify({ id: 'note', name: 'Note', tier: 'official', defaultEnabled: true, parts: { pane: { builtin: 'note' } } }))
      const registry = new PluginRegistry({ officialDir: join(dir, 'official'), customFile: join(dir, 'p', 'custom.json') })
      const store = new PluginStore(join(dir, 'p'))
      const service = new SpacePluginService(registry, store)
      const spaces = [{ id: 'a', agent: null, ownRuntime: false }, { id: 'b', agent: null, ownRuntime: false }]
      const source = { claudeJson: join(dir, 'missing.json'), agents: [] }
      await service.setup(spaces, { time: true, note: false }, source, join(dir, 'backups'))
      expect((await store.spaces()).spaces).toEqual({ a: { plugins: { time: { connections: [] } }, off: [] }, b: { plugins: { time: { connections: [] } }, off: [] } })
      expect((await store.spaces()).imported).toEqual([])
      await service.setPlugin('a', 'time', false)
      await service.setup(spaces, { time: true }, source, join(dir, 'backups'))
      expect(await service.enabled('a', 'time')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('outside servers and Codex', () => {
  it('reads the connector and Claude Code plugin names from claude mcp list', () => {
    const out = 'Checking MCP server health…\n\nclaude.ai Slack: https://mcp.slack.example/mcp - ✔ Connected\nplugin:stripe:stripe: https://mcp.stripe.example (HTTP) - ! Needs authentication\nlocal: npx x - ✔ Connected\n'
    expect(parseMcpList(out)).toEqual([{ name: 'claude.ai Slack', kind: 'connector' }, { name: 'plugin:stripe:stripe', kind: 'claude-plugin' }])
  })

  it('writes each server once, off, a second entry for another fill, and switches a space on by name', () => {
    const a = { type: 'stdio' as const, command: 'q', args: [], env: { K: 'placeholder-1' } }
    const b = { ...a, env: { K: 'placeholder-2' } }
    const { tables, names } = codexPluginTables({ one: { qonto: a }, two: { qonto: b, web: { type: 'sse', url: 'https://x.example', headers: {} } } })
    expect(tables.map((t) => t.header)).toEqual(['mcp_servers.qonto', 'mcp_servers.qonto_2'])
    expect(tables[0].lines).toContain('enabled = false')
    expect(names).toEqual({ one: ['qonto'], two: ['qonto_2'] })
    expect(codexPluginArgs(names.two)).toEqual(['--config', 'mcp_servers.qonto_2.enabled=true'])
  })
})

describe('the channel bridge accounts', () => {
  const gmail = (() => {
    const result = readManifest({ id: 'gmail', name: 'Gmail', tier: 'official', parts: { channel: { adapter: 'gmail' } }, auth: { kind: 'google-oauth' } }, 'official')
    if (!result.ok) throw new Error(result.reason)
    return result.manifest
  })()
  const work = { id: 'work-mail', plugin: 'gmail', label: 'Work', values: { address: 'me@work.example', credentialsFile: '/c', tokenFile: '/t' } }
  const home = { id: 'home-mail', plugin: 'gmail', label: 'Home', values: { address: 'me@home.example', credentialsFile: '/c2', tokenFile: '/t2' } }

  it('makes one account per connection, on in every space that picked it, leaving out spaces without a token', async () => {
    const { bridgeAccountsFor } = await import('../src/domain/space-plugins.js')
    let state = setPlugin(emptySpacePlugins(), 'main', 'gmail', { connections: ['work-mail'] })
    state = setPlugin(state, 'eml', 'gmail', { connections: ['work-mail'] })
    state = setPlugin(state, 'shared', 'gmail', { connections: ['work-mail'] })
    state = setPlugin(state, 'private', 'gmail', { connections: [] })
    const { accounts, problems } = bridgeAccountsFor(state, [gmail], [work, home], ['main', 'eml', 'private'])
    expect(accounts).toEqual([{ type: 'gmail', accountId: 'work-mail', spaces: ['eml', 'main'], address: 'me@work.example', credentialsFile: '/c', tokenFile: '/t' }])
    expect(problems).toHaveLength(2)
    // The channel part switched off for every space: no account at all.
    expect(bridgeAccountsFor({ ...state, partsOff: { gmail: ['channel'] } }, [gmail], [work], ['main']).accounts).toEqual([])
  })

  it('turns the accounts file of before into connections once, keeping each account id', async () => {
    const { importBridgeAccounts, writeBridgeAccounts } = await import('../src/infrastructure/plugins/bridge-accounts.js')
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-bridge-accounts-'))
    try {
      const file = join(dir, 'accounts.json')
      writeFileSync(file, JSON.stringify([{ type: 'gmail', accountId: 'home-mail', space: 'main', address: 'me@home.example', credentialsFile: '/c2', tokenFile: '/t2' }]))
      const store = new PluginStore(join(dir, 'plugins'))
      expect(await importBridgeAccounts(file, store, join(dir, 'backups'))).toEqual(['home-mail'])
      expect(await importBridgeAccounts(file, store, join(dir, 'backups'))).toEqual([])
      expect(await store.connections()).toEqual([{ ...home, label: 'me@home.example' }])
      expect((await store.spaces()).spaces.main.plugins.gmail).toEqual({ connections: ['home-mail'] })
      expect(readdirSync(join(dir, 'backups'))).toHaveLength(1)
      // Written by the cockpit from then on: unchanged is no change, none removes the file.
      const accounts = [{ type: 'gmail', accountId: 'home-mail', spaces: ['main'], address: 'me@home.example' }]
      expect(await writeBridgeAccounts(file, accounts)).toBe(true)
      expect(await writeBridgeAccounts(file, accounts)).toBe(false)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(await writeBridgeAccounts(file, [])).toBe(true)
      expect(readdirSync(dir)).not.toContain('accounts.json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('several sign-ins and name clashes', () => {
  it('reads a file of before with one connection per space', async () => {
    const { spacePluginsSchema } = await import('../src/domain/space-plugins.js')
    const state = spacePluginsSchema.parse({ version: 1, spaces: { a: { plugins: { x: { connection: 'c1' }, y: { connection: null } } } } })
    expect(state.spaces.a.plugins).toEqual({ x: { connections: ['c1'] }, y: { connections: [] } })
  })

  it('lets an official plugin keep its server name: an imported server of that name stays out', () => {
    const official = (() => { const r = readManifest({ id: 'gmail', name: 'Gmail', tier: 'official', parts: { mcp: { transport: 'stdio', command: '${NODE}', args: ['${COCKPIT_DIST}/gmail-mcp.cjs'], env: { T: { secret: 'tokenFile' } } } } }, 'official'); if (!r.ok) throw new Error(r.reason); return r.manifest })()
    const imported = manifest({ id: 'gmail-claude-config', name: 'gmail', tier: 'custom', parts: { mcp: { transport: 'http', serverName: 'gmail', url: 'http://127.0.0.1:1/mcp' } } })
    let state = setPlugin(emptySpacePlugins(), 'a', 'gmail', { connections: ['g1'] })
    state = setPlugin(state, 'a', 'gmail-claude-config', { connections: [] })
    const g1 = { id: 'g1', plugin: 'gmail', label: 'Work', values: { tokenFile: '/t' } }
    const { servers, problems } = mcpServersFor('a', state, [official, imported], [g1], { NODE: '/usr/bin/node', COCKPIT_DIST: '/app/dist' })
    expect(servers).toEqual({ gmail: { type: 'stdio', command: '/usr/bin/node', args: ['/app/dist/gmail-mcp.cjs'], env: { T: '/t' } } })
    expect(problems).toEqual(['gmail: left out, gmail serves gmail here'])
  })
})

describe('switching a plugin on without naming a connection', () => {
  it('keeps the one it has in the space, else takes the plugin\'s only one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-space-connection-'))
    try {
      const registry = new PluginRegistry({ officialDir: join(dir, 'none'), customFile: join(dir, 'p', 'custom.json') })
      await registry.addCustom({ id: 'lookup', name: 'Lookup', parts: { mcp: { transport: 'stdio', command: 'x', env: { K: { secret: 'k' } } } } })
      const store = new PluginStore(join(dir, 'p'))
      const service = new SpacePluginService(registry, store)
      await service.saveConnection({ id: 'only', plugin: 'lookup', label: 'x', values: { k: 'placeholder' } })
      await service.setPlugin('a', 'lookup', true)
      expect((await store.spaces()).spaces.a.plugins.lookup).toEqual({ connections: ['only'] })
      await service.saveConnection({ id: 'second', plugin: 'lookup', label: 'y', values: { k: 'placeholder-2' } })
      await service.setPlugin('a', 'lookup', true, ['second'])
      await service.setPlugin('a', 'lookup', true)
      expect((await store.spaces()).spaces.a.plugins.lookup).toEqual({ connections: ['second'] })
      // Both at once: one server each, the second under its short name.
      await service.saveConnection({ id: 'third', plugin: 'lookup', label: 'z', slug: 'invoice', values: { k: 'placeholder-3' } })
      await service.setPlugin('a', 'lookup', true, ['second', 'third'])
      expect(Object.keys((await service.snapshot()).filesFor('a').mcpServers)).toEqual(['lookup', 'lookup-invoice'])
      await service.setPlugin('b', 'lookup', true)
      expect((await store.spaces()).spaces.b.plugins.lookup).toEqual({ connections: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
