import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

  const { handlePluginsApi } = await import('../src/plugins-api.js')
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
  it('lists every plugin as on until it is switched off', async () => {
    const res = await fetch(`${base}/api/plugins`)
    expect(await res.json()).toEqual({ plugins: [{ id: 'brain', enabled: true }, { id: 'note', enabled: true }, { id: 'worktrees', enabled: true }, { id: 'repository', enabled: true }, { id: 'shell', enabled: true }] })
  })

  it('refuses an unknown plugin or a non-boolean', async () => {
    expect((await patch({ id: 'terminal', enabled: false })).status).toBe(400)
    expect((await patch({ id: 'note', enabled: 'no' })).status).toBe(400)
  })

  it('keeps a switch in the config and refuses the plugin\'s routes while off', async () => {
    const res = await patch({ id: 'note', enabled: false })
    expect((await res.json()).plugins).toContainEqual({ id: 'note', enabled: false })
    expect(JSON.parse(readFileSync(join(home, 'config'), 'utf8')).plugins).toEqual({ note: false })
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
