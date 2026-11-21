import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// The cockpit's own plugins (plugins-api.ts): the switches, kept in the
// config for every browser; a plugin that is off answers 404 on its routes,
// Notes included; Worktrees reads the project's folder from the registry
// only, and lists its worktrees against the default branch; Repository reads a
// checkout of that folder only, and nothing outside it.

const home = mkdtempSync(join(tmpdir(), 'cockpit-plugins-api-test-'))
process.env.EML_COCKPIT_HOME = home
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-plugins-repo-')))
// A worktree next to the checkout, as the repo's own worktrees are.
const wtX = `${repo}-x`
// A project folder that is no repository.
const plain = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-plugins-plain-')))

let host: http.Server
let pluginsModule: typeof import('../src/plugins-api.js')
let base: string

// The Shell plugin's running terminals, as the bridge would hold them.
const shells = new Set(['sh-1'])

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).toString()

beforeAll(async () => {
  writeFileSync(join(home, 'config'), JSON.stringify({ token: 't' }))
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'first')
  git('worktree', 'add', '-q', '-b', 'feat/x', wtX)
  writeFileSync(join(wtX, 'b.txt'), 'b\n')
  execFileSync('git', ['-C', wtX, 'add', 'b.txt'])
  execFileSync('git', ['-C', wtX, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'second'])
  writeFileSync(join(repo, 'dirty.txt'), 'x\n')

  const { handlePluginsApi, spacePlugins } = await import('../src/plugins-api.js')
  pluginsModule = await import('../src/plugins-api.js')
  // A home's first boot: the switches an older cockpit kept (none here) carry over to both spaces.
  await spacePlugins.setup(
    [{ id: 'main', agent: null, ownRuntime: false }, { id: 'other', agent: null, ownRuntime: false }],
    {}, { claudeJson: join(home, 'claude-config', '.claude.json'), agents: [] }, join(home, 'plugins', 'backups'),
  )
  const { TimeTracker } = await import('../src/time-tracking.js')
  const folders: Record<string, string> = { p1: repo, p2: plain }
  const deps = {
    projectFolder: (id: string) => folders[id] ?? null,
    ports: async () => [
      { port: 5173, address: '127.0.0.1', pid: 42, command: 'node', cwd: wtX, startedAt: '2026-11-12T10:00:00.000Z', commandLine: `node ${dirname(repo)}/vite.js --api-token abc123`, memory: 1024, ancestors: [41, 40] },
      { port: 5000, address: '*', pid: 7, command: 'ControlCenter', cwd: '/', startedAt: null, commandLine: '/System/ControlCenter', memory: null, ancestors: [] },
      { port: 6000, address: '127.0.0.1', pid: 8, command: 'node', cwd: dirname(repo), startedAt: null, commandLine: 'node brain.js', memory: null, ancestors: [] },
      { port: 4317, address: '127.0.0.1', pid: 900, command: 'node', cwd: dirname(repo), startedAt: null, commandLine: 'node ~/.eml-cockpit/app/current/node_modules/eml-cockpit/dist/index.js', memory: null, ancestors: [1] },
      { port: 7100, address: '127.0.0.1', pid: 950, command: 'codex', cwd: dirname(repo), startedAt: null, commandLine: 'codex --no-daemon', memory: null, ancestors: [940, 900] },
    ],
    sessionProcesses: () => new Map([[40, { id: 's1', name: 'Dev server session', projectId: 'p1' }]]),
    ownPorts: () => new Map([[6000, 'EML brain server']]),
    endShell: (id: string) => shells.delete(id),
    spaceIds: () => ['main', 'other'],
    outside: { list: async () => [{ name: 'claude.ai Slack', kind: 'connector' as const }] },
    time: new TimeTracker(() => ({ spaceId: null, projectId: 'p1', taskId: null }), async () => true, join(home, 'time')),
    sessionName: (id: string) => (id === 's1' ? 'Dev server session' : null),
    timeNames: async ({ projects }: { projects: Array<{ spaceId: string | null; projectId: string | null }> }) => ({
      spaces: { '': 'Main' },
      projects: Object.fromEntries(projects.map((p) => [`${p.spaceId ?? ''}/${p.projectId ?? ''}`, 'Project one'])),
      tasks: {},
    }),
    // The user's home folder: the temp folder the repo lies in.
    home: dirname(repo),
  }
  host = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (r: http.ServerResponse, status: number, payload: unknown) => { r.writeHead(status, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(payload)) }
    const readJson = async (r: http.IncomingMessage) => {
      let raw = ''
      for await (const c of r) raw += c
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    }
    void handlePluginsApi(req, res, deps, url, req.method ?? 'GET', json, readJson)
      .then((handled) => { if (!handled) json(res, 418, { passed: true }) })
  })
  base = `http://127.0.0.1:${await listen(host)}`
})

afterAll(async () => {
  await new Promise((r) => host.close(r))
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
  rmSync(wtX, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
})

const patch = (body: unknown) => fetch(`${base}/api/plugins`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('plugin switches', () => {
  it('starts with Brain, Note and Worktrees on and the later plugins off', async () => {
    const res = await fetch(`${base}/api/plugins`)
    const { plugins } = await res.json()
    expect(Object.fromEntries(plugins.map((p: { id: string; enabled: boolean }) => [p.id, p.enabled]))).toEqual({
      brain: true, note: true, worktrees: true, repository: false, shell: false, time: false, gmail: false,
    })
  })

  it('describes each official plugin by its manifest', async () => {
    const { plugins } = await (await fetch(`${base}/api/plugins`)).json()
    expect(plugins.find((p: { id: string }) => p.id === 'note')).toMatchObject({ name: 'Note', tier: 'official', parts: ['pane'], pane: 'note', channel: null, mcp: null })
    expect(plugins.find((p: { id: string }) => p.id === 'gmail')).toMatchObject({ tier: 'official', parts: ['mcp', 'channel'], pane: null, channel: 'gmail', auth: { kind: 'google-oauth' }, mcp: { transport: 'stdio', target: 'gmail-mcp.cjs' } })
  })

  // Switches every plugin on for the tests below.
  it('keeps what the user chose over the default', async () => {
    await patch({ id: 'brain', enabled: false })
    for (const id of ['note', 'worktrees', 'repository', 'shell', 'time', 'gmail']) await patch({ id, enabled: true })
    const res = await patch({ id: 'brain', enabled: true })
    expect((await res.json()).plugins.every((p: { enabled: boolean }) => p.enabled)).toBe(true)
  })

  it('refuses an unknown plugin or a non-boolean', async () => {
    expect((await patch({ id: 'terminal', enabled: false })).status).toBe(400)
    expect((await patch({ id: 'note', enabled: 'no' })).status).toBe(400)
  })

  it('keeps a switch in the config and refuses the plugin\'s routes while off', async () => {
    const res = await patch({ id: 'note', enabled: false })
    expect((await res.json()).plugins).toContainEqual(expect.objectContaining({ id: 'note', enabled: false }))
    expect(JSON.parse(readFileSync(join(home, 'plugins', 'spaces.json'), 'utf8')).spaces.main.plugins.note).toBeUndefined()
    expect((await fetch(`${base}/api/notes?projectId=p1`)).status).toBe(404)
    expect((await fetch(`${base}/api/notes/abc`)).status).toBe(404)

    await patch({ id: 'note', enabled: true })
    // On again: the notes routes go on to notes-api.ts.
    expect((await fetch(`${base}/api/notes?projectId=p1`)).status).toBe(418)
  })

  it('answers 404 on Worktrees routes while it is off', async () => {
    await patch({ id: 'worktrees', enabled: false })
    expect((await fetch(`${base}/api/plugins/worktrees/ports`)).status).toBe(404)
    await patch({ id: 'worktrees', enabled: true })
  })

  it('answers 404 on Repository routes while it is off', async () => {
    await patch({ id: 'repository', enabled: false })
    expect((await fetch(`${base}/api/plugins/repository/repo?projectId=p1`)).status).toBe(404)
    await patch({ id: 'repository', enabled: true })
    expect((await fetch(`${base}/api/plugins/repository/repo?projectId=p1`)).status).toBe(200)
  })
})

describe('custom MCP plugins', () => {
  const add = (body: unknown) => fetch(`${base}/api/plugins/custom`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const lookup = { id: 'lookup', name: 'Lookup', parts: { mcp: { transport: 'stdio', command: 'lookup-mcp', args: ['--token', 'abc'], env: { LOOKUP_KEY: { secret: 'key' }, LOOKUP_REGION: 'eu' } } } }

  it('adds one owner-only, starts it off and shows its settings by name only', async () => {
    const res = await add(lookup)
    expect(res.status).toBe(201)
    expect((await res.json()).plugin).toMatchObject({
      id: 'lookup', tier: 'custom', parts: ['mcp'], enabled: false,
      mcp: { transport: 'stdio', target: 'lookup-mcp', settings: [{ name: 'LOOKUP_KEY', secret: true }, { name: 'LOOKUP_REGION', secret: false }] },
    })
    const listed = JSON.stringify(await (await fetch(`${base}/api/plugins`)).json())
    expect(listed).toContain('"lookup"')
    expect(listed).not.toContain('abc')
    expect(listed).not.toContain('"eu"')
    const file = join(home, 'plugins', 'custom.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8')).plugins[0]).toMatchObject({ id: 'lookup', tier: 'custom' })
  })

  it('refuses a taken id, an official one, a channel or a pane, and a bad manifest', async () => {
    expect((await add(lookup)).status).toBe(400)
    expect((await add({ ...lookup, id: 'gmail' })).status).toBe(400)
    expect((await add({ ...lookup, id: 'mail2', parts: { channel: { adapter: 'gmail' } } })).status).toBe(400)
    expect((await add({ ...lookup, id: 'view2', parts: { pane: { builtin: 'note' } } })).status).toBe(400)
    expect((await add({ id: 'Bad Id', name: 'x', parts: {} })).status).toBe(400)
    // It can't make itself official.
    const official = await add({ ...lookup, id: 'sneaky', tier: 'official' })
    expect((await official.json()).plugin).toMatchObject({ tier: 'custom' })
    await fetch(`${base}/api/plugins/custom/sneaky`, { method: 'DELETE' })
  })

  it('switches like any plugin and forgets the switch when removed', async () => {
    await patch({ id: 'lookup', enabled: true, space: 'other' })
    const spaces = () => JSON.parse(readFileSync(join(home, 'plugins', 'spaces.json'), 'utf8')).spaces
    expect(spaces().other.plugins.lookup).toEqual({ connections: [] })
    expect(spaces().main.plugins.lookup).toBeUndefined()
    expect((await fetch(`${base}/api/plugins/custom/lookup`, { method: 'DELETE' })).status).toBe(200)
    expect((await fetch(`${base}/api/plugins/custom/lookup`, { method: 'DELETE' })).status).toBe(404)
    expect(spaces().other.plugins.lookup).toBeUndefined()
    expect((await patch({ id: 'lookup', enabled: true })).status).toBe(400)
  })
})

describe('plugins per space', () => {
  const view = async (space: string, id: string) =>
    (await (await fetch(`${base}/api/plugins?space=${space}`)).json()).plugins.find((p: { id: string }) => p.id === id)

  it('switches a plugin in one space only and tells each space its own state', async () => {
    await patch({ id: 'time', enabled: false, space: 'other' })
    expect(await view('main', 'time')).toMatchObject({ enabled: true })
    expect(await view('other', 'time')).toMatchObject({ enabled: false, spaces: { main: [] } })
    await patch({ id: 'time', enabled: true, space: 'other' })
  })

  it('keeps connections owner-only and never sends their values back', async () => {
    const res = await fetch(`${base}/api/plugins/connections`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugin: 'gmail', label: 'Test mailbox', values: { token: 'placeholder-value' } }),
    })
    expect(res.status).toBe(201)
    const { connection } = await res.json()
    expect(connection).toMatchObject({ plugin: 'gmail', label: 'Test mailbox', secrets: ['token'] })
    const listed = JSON.stringify(await (await fetch(`${base}/api/plugins/connections`)).json())
    expect(listed).not.toContain('placeholder-value')
    expect(statSync(join(home, 'plugins', 'connections.json')).mode & 0o777).toBe(0o600)
    // A connection of another plugin can't be picked.
    expect((await patch({ id: 'time', enabled: true, space: 'main', connection: connection.id })).status).toBe(400)
    expect((await patch({ id: 'gmail', enabled: true, space: 'main', connection: connection.id })).status).toBe(200)
    expect(await view('main', 'gmail')).toMatchObject({ enabled: true, spaces: { main: [connection.id] } })
    // Removed, the space keeps the plugin without one.
    expect((await fetch(`${base}/api/plugins/connections/${connection.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await view('main', 'gmail')).toMatchObject({ enabled: true, spaces: { main: [] } })
    await patch({ id: 'gmail', enabled: false, space: 'main' })
  })

  it('lets a remote user add a custom server once remote access lets the shell in', async () => {
    writeFileSync(join(home, 'remote.json'), JSON.stringify({ origins: ['https://cockpit.example'], users: [], shell: true }))
    try {
      const res = await fetch(`${base}/api/plugins/custom`, {
        method: 'POST', headers: { 'x-forwarded-for': '100.64.0.2', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'remote-two', name: 'R', parts: { mcp: { transport: 'stdio', command: 'x' } } }),
      })
      expect(res.status).toBe(201)
      await fetch(`${base}/api/plugins/custom/remote-two`, { method: 'DELETE' })
    } finally {
      rmSync(join(home, 'remote.json'), { force: true })
    }
  })

  it('lets a remote user remove a custom server without the shell on', async () => {
    const added = await fetch(`${base}/api/plugins/custom`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'remote-gone', name: 'G', parts: { mcp: { transport: 'stdio', command: 'x' } } }),
    })
    expect(added.status).toBe(201)
    const removed = await fetch(`${base}/api/plugins/custom/remote-gone`, { method: 'DELETE', headers: { 'x-forwarded-for': '100.64.0.2' } })
    expect(removed.status).toBe(200)
  })

  it('lets a remote user see and add sign-ins, but adds a custom server remotely only with the shell on', async () => {
    const remote = { 'x-forwarded-for': '100.64.0.2', 'Content-Type': 'application/json' }
    expect((await fetch(`${base}/api/plugins/connections`, { headers: remote })).status).toBe(200)
    const custom = await fetch(`${base}/api/plugins/custom`, {
      method: 'POST', headers: remote, body: JSON.stringify({ id: 'remote-one', name: 'R', parts: { mcp: { transport: 'stdio', command: 'x' } } }),
    })
    expect(custom.status).toBe(403)
    expect((await custom.json()).error.message).toContain('remote shell on')
  })

  it('deletes a removed sign-in\'s token file when the cockpit wrote it, never one another program keeps', async () => {
    const google = join(home, 'plugins', 'google')
    mkdirSync(google, { recursive: true })
    const own = join(google, 'abc.token.json')
    const foreign = join(home, 'elsewhere.token.json')
    writeFileSync(own, '{}')
    writeFileSync(foreign, '{}')
    const add = (tokenFile: string) => fetch(`${base}/api/plugins/connections`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugin: 'gmail', label: 'x', values: { tokenFile } }),
    }).then((r) => r.json()).then((b) => b.connection.id as string)
    const ownId = await add(own)
    const foreignId = await add(foreign)
    await fetch(`${base}/api/plugins/connections/${ownId}`, { method: 'DELETE' })
    await fetch(`${base}/api/plugins/connections/${foreignId}`, { method: 'DELETE' })
    expect(existsSync(own)).toBe(false)
    expect(existsSync(foreign)).toBe(true)
  })

  it('tells of the imported servers until the notice is done', async () => {
    await pluginsModule.pluginStore.updateSpaces((state) => ({ ...state, imported: ['lookup-imported'], importNoticeDone: false }))
    expect((await (await fetch(`${base}/api/plugins`)).json()).importNotice).toEqual({ count: 1 })
    expect((await fetch(`${base}/api/plugins/import-notice`, { method: 'DELETE' })).status).toBe(200)
    expect((await (await fetch(`${base}/api/plugins`)).json()).importNotice).toBeNull()
  })

  it('switches a part off for every space and on again', async () => {
    const parts = (enabled: boolean) => fetch(`${base}/api/plugins/parts`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'gmail', part: 'mcp', enabled }) })
    expect((await (await parts(false)).json()).plugins.find((p: { id: string }) => p.id === 'gmail').partsOff).toEqual(['mcp'])
    expect((await (await parts(true)).json()).plugins.find((p: { id: string }) => p.id === 'gmail').partsOff).toEqual([])
    expect((await fetch(`${base}/api/plugins/parts`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'gmail', part: 'wings', enabled: false }) })).status).toBe(400)
  })

  it('offers the OAuth client an earlier sign-in was made with, and copies it on request', async () => {
    const clientFile = join(home, 'earlier-client.json')
    writeFileSync(clientFile, JSON.stringify({ installed: { client_id: 'client-placeholder', client_secret: 'secret-placeholder' } }))
    const add = (credentialsFile: string) => fetch(`${base}/api/plugins/connections`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugin: 'gmail', label: 'Earlier', values: { credentialsFile } }),
    }).then((r) => r.json()).then((b) => b.connection.id as string)
    const earlier = await add(clientFile)
    const gone = await add(join(home, 'no-such-client.json'))
    const client = await (await fetch(`${base}/api/plugins/google/client`)).json()
    expect(client).toMatchObject({ configured: false, fromSignIns: expect.arrayContaining([{ id: earlier, label: 'Earlier' }]) })
    const put = (fromConnection: string) => fetch(`${base}/api/plugins/google/client`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromConnection }) })
    expect((await put(gone)).status).toBe(400)
    expect(await (await put(earlier)).json()).toMatchObject({ configured: true })
    expect(JSON.parse(readFileSync(join(home, 'plugins', 'google', 'client.json'), 'utf8')).installed.client_id).toBe('client-placeholder')
    expect(statSync(join(home, 'plugins', 'google', 'client.json')).mode & 0o777).toBe(0o600)
    for (const id of [earlier, gone]) await fetch(`${base}/api/plugins/connections/${id}`, { method: 'DELETE' })
  })

  it('switches a claude.ai connector off in one space', async () => {
    const res = await fetch(`${base}/api/plugins/outside`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ space: 'other', server: 'claude.ai Slack', enabled: false }),
    })
    expect((await res.json()).servers).toEqual([{ name: 'claude.ai Slack', kind: 'connector', off: ['other'] }])
    await fetch(`${base}/api/plugins/outside`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ space: 'other', server: 'claude.ai Slack', enabled: true }),
    })
  })
})

describe('shell', () => {
  it('ends a shell whose pane was closed, once', async () => {
    const end = () => fetch(`${base}/api/plugins/shell/sh-1`, { method: 'DELETE' }).then((r) => r.json())
    expect(await end()).toEqual({ ended: true })
    expect(await end()).toEqual({ ended: false })
    expect((await fetch(`${base}/api/plugins/shell/..%2Fx`, { method: 'DELETE' })).status).toBe(418)
  })
})

describe('worktrees', () => {
  it('lists the worktrees of the project folder against the default branch', async () => {
    const res = await fetch(`${base}/api/plugins/worktrees/git?projectId=p1`)
    const body = await res.json()
    expect(body.base).toBe('main')
    const main = body.worktrees.find((wt: { branch: string }) => wt.branch === 'main')
    const feat = body.worktrees.find((wt: { branch: string }) => wt.branch === 'feat/x')
    expect(main).toMatchObject({ path: repo, dirty: 1, ahead: 0, behind: 0, isProjectFolder: true })
    expect(feat).toMatchObject({ path: wtX, dirty: 0, ahead: 1, behind: 0, isProjectFolder: false })
    expect(feat.lastCommit.subject).toBe('second')
    expect(feat.commits.map((c: { subject: string }) => c.subject)).toEqual(['second'])
    expect(feat.createdAt).toEqual(expect.any(String))
    expect(main.createdAt).toBeNull()
    expect(main.changes).toEqual([{ code: '??', path: 'dirty.txt' }])
  })

  it('takes the folder from the registry only: an unknown project has none', async () => {
    expect((await fetch(`${base}/api/plugins/worktrees/git?projectId=${encodeURIComponent(repo)}`)).status).toBe(404)
  })

  it('reports a folder that is no repository', async () => {
    const { worktreesGit } = await import('../src/plugins-api.js')
    const plain = mkdtempSync(join(tmpdir(), 'cockpit-plugins-plain-'))
    mkdirSync(join(plain, 'x'))
    expect(await worktreesGit(plain, async () => null)).toEqual({ folder: plain, base: null, worktrees: null })
    rmSync(plain, { recursive: true, force: true })
  })

  it('names who a port belongs to and keeps secrets out of the command line', async () => {
    const body = await (await fetch(`${base}/api/plugins/worktrees/ports`)).json()
    const [vite, system, brain] = body.ports
    expect(vite).toMatchObject({ port: 5173, cwd: wtX, memory: 1024, commandLine: 'node ~/vite.js --api-token <secret>', label: null, system: false })
    expect(vite.session).toEqual({ id: 's1', name: 'Dev server session', projectId: 'p1' })
    expect(vite).not.toHaveProperty('ancestors')
    expect(system).toMatchObject({ session: null, system: true })
    expect(brain).toMatchObject({ label: 'EML brain server', system: false })
    // Another cockpit's host, and a session of it: its sessions are not this host's to name.
    expect(body.ports[3]).toMatchObject({ label: 'EML Cockpit', session: null })
    expect(body.ports[4]).toMatchObject({ label: 'Session in EML Cockpit :4317', session: null })
  })

  it('shows the port list on this machine only', async () => {
    const res = await fetch(`${base}/api/plugins/worktrees/ports`, { headers: { 'x-forwarded-for': '100.64.0.2' } })
    expect(res.status).toBe(403)
  })
})

describe('repository', () => {
  const get = async (route: string, query: Record<string, string>) => {
    const res = await fetch(`${base}/api/plugins/repository/${route}?${new URLSearchParams(query)}`)
    return { status: res.status, body: await res.json() }
  }
  const inX = (extra: Record<string, string> = {}) => ({ projectId: 'p1', worktree: wtX, ...extra })
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-plugins-outside-')))

  beforeAll(() => {
    // feat/x: a.txt changed, a new file, a secret, an ignored build folder, a link out of the checkout.
    writeFileSync(join(wtX, 'a.txt'), 'a\nmore\n')
    writeFileSync(join(wtX, 'new.txt'), 'one\ntwo\n')
    writeFileSync(join(wtX, '.env'), 'API_KEY=secret\n')
    writeFileSync(join(wtX, '.gitignore'), 'build/\n')
    mkdirSync(join(wtX, 'build'))
    writeFileSync(join(wtX, 'build', 'out.js'), 'x\n')
    writeFileSync(join(outside, 'private.txt'), 'private\n')
    symlinkSync(join(outside, 'private.txt'), join(wtX, 'link.txt'))
    // A link inside the checkout to the secret: named like a plain file.
    symlinkSync('.env', join(wtX, 'notes.txt'))
    writeFileSync(join(plain, 'readme.md'), '# plain\n')
  })
  afterAll(() => rmSync(outside, { recursive: true, force: true }))

  it('lists the project\'s checkouts, the project folder marked', async () => {
    const { body } = await get('repo', { projectId: 'p1' })
    expect(body.base).toBe('main')
    expect(body.worktrees).toEqual([
      expect.objectContaining({ path: repo, branch: 'main', isProjectFolder: true }),
      expect.objectContaining({ path: wtX, branch: 'feat/x', isProjectFolder: false }),
    ])
  })

  it('lists the uncommitted changes with new files, the branch\'s and a commit\'s', async () => {
    const uncommitted = (await get('files', inX({ scope: 'uncommitted' }))).body.files
    expect(uncommitted).toContainEqual({ path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 0 })
    expect(uncommitted).toContainEqual({ path: 'new.txt', oldPath: null, status: '?', additions: 2, deletions: 0 })
    expect(uncommitted.map((f: { path: string }) => f.path)).not.toContain('build/out.js')
    expect((await get('files', inX({ scope: 'branch' }))).body.files).toEqual([{ path: 'b.txt', oldPath: null, status: 'A', additions: 1, deletions: 0 }])
    const { body: log } = await get('commits', inX())
    expect(log).toMatchObject({ base: 'main', onBranch: true, commits: [{ subject: 'second', author: 't' }] })
    const commit = (await get('files', inX({ scope: 'commit', commit: log.commits[0].hash }))).body.files
    expect(commit.map((f: { path: string }) => f.path)).toEqual(['b.txt'])
    // The first commit has no parent: compared with nothing.
    const first = git('rev-parse', '--short', 'main').trim()
    expect((await get('files', inX({ scope: 'commit', commit: first }))).body.files.map((f: { path: string }) => f.path)).toEqual(['a.txt'])
    expect((await get('files', inX({ scope: 'commit', commit: 'zz' }))).status).toBe(400)
  })

  it('shows a file\'s patch, a new file\'s whole, a secret only on reveal', async () => {
    expect((await get('patch', inX({ scope: 'uncommitted', path: 'a.txt' }))).body.patch).toContain('\n+more\n')
    expect((await get('patch', inX({ scope: 'uncommitted', path: 'new.txt', status: '?' }))).body.patch).toBe('@@ -0,0 +1,2 @@\n+one\n+two\n')
    expect((await get('patch', inX({ scope: 'uncommitted', path: '.env', status: '?' }))).body).toEqual({ patch: null, truncated: false, secret: true })
    expect((await get('patch', inX({ scope: 'uncommitted', path: '.env', status: '?', reveal: '1' }))).body.patch).toContain('+API_KEY=secret')
    expect((await get('patch', inX({ scope: 'uncommitted', path: '../x' }))).status).toBe(400)
  })

  it('reads files inside the checkout only', async () => {
    expect((await get('file', inX({ path: 'new.txt' }))).body).toMatchObject({ content: 'one\ntwo\n', secret: false, binary: false })
    expect((await get('file', inX({ path: '.env' }))).body).toMatchObject({ content: null, secret: true })
    expect((await get('file', inX({ path: '.env', reveal: '1' }))).body.content).toBe('API_KEY=secret\n')
    for (const path of ['link.txt', '../' + 'x/a.txt', join(outside, 'private.txt'), '']) {
      expect((await get('file', inX({ path }))).status).toBe(404)
    }
  })

  it('keeps a secret behind a link a secret, and the .git folder closed', async () => {
    expect((await get('file', inX({ path: 'notes.txt' }))).body).toMatchObject({ content: null, secret: true })
    expect((await get('patch', inX({ scope: 'uncommitted', path: 'notes.txt', status: '?' }))).body).toEqual({ patch: null, truncated: false, secret: true })
    expect((await get('file', inX({ path: 'notes.txt', reveal: '1' }))).body.content).toBe('API_KEY=secret\n')
    // .git/config can hold a token in a remote URL.
    expect((await get('file', { projectId: 'p1', worktree: repo, path: '.git/config' })).status).toBe(404)
  })

  it('reads only checkouts of the project folder', async () => {
    expect((await get('tree', { projectId: 'p1', worktree: outside })).status).toBe(404)
    expect((await get('tree', { projectId: 'p1', worktree: dirname(repo) })).status).toBe(404)
    expect((await get('file', { projectId: 'p1', path: 'a.txt' })).body.content).toBe('a\n')
  })

  it('lists the tree with the ignored folders apart, and a folder\'s entries', async () => {
    const { body } = await get('tree', inX())
    expect(body.paths).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'new.txt', '.gitignore']))
    expect(body.ignored).toEqual(['build/'])
    expect((await get('dir', inX({ path: 'build' }))).body.entries).toEqual([{ name: 'out.js', dir: false }])
    const root = (await get('dir', inX())).body.entries.map((e: { name: string }) => e.name)
    expect(root).toContain('build')
    expect(root).not.toContain('.git')
    expect((await get('dir', inX({ path: '..' }))).status).toBe(404)
  })

  it('shows a folder that is no repository as files only', async () => {
    expect((await get('repo', { projectId: 'p2' })).body).toEqual({ folder: plain, base: null, worktrees: null })
    expect((await get('dir', { projectId: 'p2' })).body.entries).toEqual([{ name: 'readme.md', dir: false }])
    expect((await get('file', { projectId: 'p2', path: 'readme.md' })).body.content).toBe('# plain\n')
    expect((await get('tree', { projectId: 'p2' })).status).toBe(404)
    expect((await get('dir', { projectId: 'p2', worktree: repo })).status).toBe(404)
  })

  it('parses renames in name-status and numstat', async () => {
    const { parseNameStatus, parseNumstat } = await import('../src/plugins-repository.js')
    expect(parseNameStatus('M\0a.txt\0R087\0old.txt\0new.txt\0')).toEqual([
      { path: 'a.txt', oldPath: null, status: 'M', additions: null, deletions: null },
      { path: 'new.txt', oldPath: 'old.txt', status: 'R', additions: null, deletions: null },
    ])
    expect([...parseNumstat('1\t0\ta.txt\0' + '2\t3\t\0old.txt\0new.txt\0' + '-\t-\timg.png\0')]).toEqual([
      ['a.txt', { additions: 1, deletions: 0 }],
      ['new.txt', { additions: 2, deletions: 3 }],
      ['img.png', { additions: null, deletions: null }],
    ])
  })
})

describe('secrets in a command line', () => {
  it('blacks out user info in a URL, short secret flags, -p<password> and secret headers; ports and other flags stay', async () => {
    const { redactSecrets } = await import('../src/diagnostics/redact.js')
    const cases: Array<[string, string]> = [
      ['psql postgres://app:hunter2@localhost:5432/db', 'psql postgres://app:<secret>@localhost:5432/db'],
      ['mongo mongodb://admin:pw@db.internal:27017', 'mongo mongodb://admin:<secret>@db.internal:27017'],
      ['redis-server --requirepass s3cr3tpw', 'redis-server --requirepass <secret>'],
      ['tool --pass x --auth y --key=z', 'tool --pass <secret> --auth <secret> --key=<secret>'],
      ['mysqld -pS3cret', 'mysqld -p<secret>'],
      ['curl -H X-Api-Key: abcd1234', 'curl -H X-Api-Key: <secret>'],
      ['ssh -p 22 host', 'ssh -p 22 host'],
      ['docker run -p8080 img', 'docker run -p8080 img'],
      ['git commit --author me --keyboard us', 'git commit --author me --keyboard us'],
      ['vite --port 5173 --strictPort', 'vite --port 5173 --strictPort'],
    ]
    for (const [line, shown] of cases) expect(redactSecrets(line)).toBe(shown)
  })
})

describe('lsof parsing', () => {
  it('reads listening sockets, one per address, and process folders', async () => {
    const { parseLsofListening, parseLsofCwd } = await import('../src/infrastructure/platform/common.js')
    const out = 'p101\ncnode\nn127.0.0.1:4318\nn[::1]:4318\nn127.0.0.1:4318\np202\ncvite\nn*:5173\n'
    expect(parseLsofListening(out)).toEqual([
      { port: 4318, address: '127.0.0.1', pid: 101, command: 'node' },
      { port: 4318, address: '::1', pid: 101, command: 'node' },
      { port: 5173, address: '*', pid: 202, command: 'vite' },
    ])
    const { parsePs, ancestorsOf } = await import('../src/infrastructure/platform/common.js')
    const processes = parsePs('    1     0  9000 10-00:00:00 /sbin/launchd\n  101    50 20480      05:07 node /x/vite.js --port 5173\n   50     1   100 1-02:03:04 -zsh\n')
    expect(processes.get(101)).toEqual({ ppid: 50, rss: 20480, elapsed: 307, command: 'node /x/vite.js --port 5173' })
    expect(processes.get(50)?.elapsed).toBe(93784)
    expect(ancestorsOf(101, processes)).toEqual([50])
    expect(parseLsofCwd('p101\nfcwd\nn/Users/x/eml\np202\nfcwd\nn/tmp\n')).toEqual(new Map([[101, '/Users/x/eml'], [202, '/tmp']]))
  })
})

describe('time', () => {
  it('takes beats and answers the days with the names', async () => {
    const beat = () => fetch(`${base}/api/plugins/time/beat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 's1' }) })
    expect((await beat()).status).toBe(200)
    // A moment later: the time between the two goes to the session.
    await new Promise((r) => setTimeout(r, 20))
    expect((await beat()).status).toBe(200)
    const body = await (await fetch(`${base}/api/plugins/time?days=3`)).json()
    expect(body.days).toHaveLength(3)
    expect(body.days[2].sessions.s1.projectId).toBe('p1')
    expect(body.names).toEqual({ spaces: { '': 'Main' }, projects: { '/p1': 'Project one' }, tasks: {}, sessions: { s1: 'Dev server session' } })
  })

  it('answers 404 while it is off', async () => {
    await patch({ id: 'time', enabled: false })
    expect((await fetch(`${base}/api/plugins/time`)).status).toBe(404)
    await patch({ id: 'time', enabled: true })
  })
})

describe('OAuth sign-ins to a remote MCP server', () => {
  let oauthServer: http.Server
  let remote: string

  beforeAll(async () => {
    oauthServer = http.createServer((req, res) => {
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)) }
      req.resume()
      req.on('end', () => {
        if (req.url === '/mcp') return json(401, {}, { 'www-authenticate': `Bearer resource_metadata="${remote}/.well-known/oauth-protected-resource"` })
        if (req.url === '/.well-known/oauth-protected-resource') return json(200, { resource: `${remote}/mcp`, authorization_servers: [remote] })
        if (req.url === '/.well-known/oauth-authorization-server') return json(200, { authorization_endpoint: `${remote}/authorize`, token_endpoint: `${remote}/token`, registration_endpoint: `${remote}/register` })
        if (req.url === '/register') return json(201, { client_id: 'client-1' })
        if (req.url === '/token') return json(200, { access_token: 'placeholder-access', refresh_token: 'placeholder-refresh', expires_in: 3600 })
        json(404, {})
      })
    })
    remote = `http://127.0.0.1:${await listen(oauthServer)}`
  })
  afterAll(async () => { await new Promise((r) => oauthServer.close(r)) })

  it('signs in through the server\'s consent page and its callback, then the plugin uses the cockpit\'s sign-ins', async () => {
    const added = await fetch(`${base}/api/plugins/custom`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'bank', name: 'Bank', parts: { mcp: { transport: 'http', url: `${remote}/mcp`, headers: {} } } }),
    })
    expect(added.status).toBe(201)
    const start = await fetch(`${base}/api/plugins/oauth/sign-in`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'http://127.0.0.1:4317' }, body: JSON.stringify({ plugin: 'bank', label: 'Company B', slug: 'b' }),
    })
    expect(start.status).toBe(200)
    const consent = new URL((await start.json()).url)
    expect(consent.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4317/api/plugins/oauth/callback')
    const callback = await fetch(`${base}/api/plugins/oauth/callback?state=${consent.searchParams.get('state')}&code=code-1`)
    expect(callback.status).toBe(200)
    expect(await callback.text()).toContain('Company B is signed in')
    const { connections } = await (await fetch(`${base}/api/plugins/connections`)).json()
    const signedIn = connections.find((c: { plugin: string }) => c.plugin === 'bank')
    expect(signedIn).toMatchObject({ label: 'Company B', slug: 'b', oauth: true, signInNeeded: false })
    expect(JSON.stringify(connections)).not.toContain('placeholder-access')
    const { plugins } = await (await fetch(`${base}/api/plugins`)).json()
    expect(plugins.find((p: { id: string }) => p.id === 'bank').auth).toEqual({ kind: 'mcp-oauth', scopes: [] })
    // A callback a second time, or one never started here, changes nothing.
    expect((await fetch(`${base}/api/plugins/oauth/callback?state=${consent.searchParams.get('state')}&code=code-1`)).status).toBe(400)
    await fetch(`${base}/api/plugins/custom/bank`, { method: 'DELETE' })
  })
})
