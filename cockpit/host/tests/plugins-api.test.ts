import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// The cockpit's own plugins (plugins-api.ts): the switches, kept in the
// config for every browser; a plugin that is off answers 404 on its routes,
// Notes included; Worktrees reads the project's folder from the registry
// only, and lists its worktrees against the default branch.

const home = mkdtempSync(join(tmpdir(), 'cockpit-plugins-api-test-'))
process.env.EML_COCKPIT_HOME = home
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-plugins-repo-')))
// A worktree next to the checkout, as the repo's own worktrees are.
const wtX = `${repo}-x`

let host: http.Server
let base: string

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
  const folders: Record<string, string> = { p1: repo }
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
})

const patch = (body: unknown) => fetch(`${base}/api/plugins`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('plugin switches', () => {
  it('lists every plugin as on until it is switched off', async () => {
    const res = await fetch(`${base}/api/plugins`)
    expect(await res.json()).toEqual({ plugins: [{ id: 'note', enabled: true }, { id: 'worktrees', enabled: true }] })
  })

  it('refuses an unknown plugin or a non-boolean', async () => {
    expect((await patch({ id: 'brain', enabled: false })).status).toBe(400)
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
