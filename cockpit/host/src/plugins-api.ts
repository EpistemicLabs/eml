import type * as http from 'node:http'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readCockpitConfig, updateCockpitConfig } from './config.js'
import { redactSecrets } from './diagnostics/redact.js'
import type { ListeningPort } from './domain/platform.js'
import { platform } from './infrastructure/platform/index.js'

/**
 * The cockpit's own plugins (decision cockpit-builtin-plugins-first): project
 * views next to the brain that Settings › EML Plugins switches on or off, for
 * the whole cockpit — every browser of it sees the same. Brain is no plugin
 * here: it can't be switched off.
 *
 *   GET   /api/plugins                         → { plugins: [{ id, enabled }] }
 *   PATCH /api/plugins  { id, enabled }        → the same, after the change
 *   GET   /api/plugins/worktrees/git?projectId= → the project folder's worktrees
 *   GET   /api/plugins/worktrees/ports          → the ports the user's processes listen on
 *
 * The Worktrees routes read only: the folder comes from the project registry,
 * never from the request, so a caller can't point them at another path. They
 * are shaped like the capabilities a sandboxed plugin would later call
 * (cockpit-plugin-system-implementation-plan). A plugin that is off answers
 * 404 on its routes, Notes included (/api/notes).
 */

export const PLUGIN_IDS = ['note', 'worktrees'] as const
export type PluginId = (typeof PLUGIN_IDS)[number]

const isPluginId = (value: unknown): value is PluginId => (PLUGIN_IDS as readonly unknown[]).includes(value)

/** Every plugin is on until the user switches it off. */
export async function pluginStates(): Promise<Record<PluginId, boolean>> {
  const chosen = (await readCockpitConfig())?.plugins ?? {}
  return Object.fromEntries(PLUGIN_IDS.map((id) => [id, chosen[id] !== false])) as Record<PluginId, boolean>
}

export interface Worktree {
  path: string
  /** null: a detached HEAD. */
  branch: string | null
  head: string
  /** Changed and untracked files. */
  dirty: number
  /** The first of them: `git status --porcelain`'s two-letter code and the path. */
  changes: Array<{ code: string; path: string }>
  /** Commits ahead of / behind the default branch; null without one to compare with. */
  ahead: number | null
  behind: number | null
  /** The newest commits ahead of the default branch. */
  commits: Commit[]
  lastCommit: Commit | null
  /** When the worktree was added; null for the main checkout and where the file system can't tell. */
  createdAt: string | null
  /** The folder the project is linked to (the main checkout or a worktree of it). */
  isProjectFolder: boolean
}

export interface Commit {
  hash: string
  subject: string
  at: string
}

/** How many changed files and commits a worktree lists by name. */
const LISTED = 12

export interface WorktreesGit {
  folder: string
  /** null: the folder is no git repository. */
  base: string | null
  worktrees: Worktree[] | null
}

export interface PluginsApiDeps {
  /** The pane project's folder in the request's space; null: no such project or no folder. */
  projectFolder: (projectId: string) => string | null
  /** The cockpit sessions' running agent processes, pid → session. */
  sessionProcesses?: () => Map<number, PortSession>
  /** Ports the cockpit itself serves, port → what they are ("EML brain server"). */
  ownPorts?: () => Map<number, string>
  ports?: () => Promise<ListeningPort[] | null>
  git?: Git
  home?: string
}

export interface PortSession {
  id: string
  /** What the sidebar calls it; null when it has no name yet. */
  name: string | null
  projectId: string | null
}

/** A listening port as the Worktrees view shows it. */
export interface PortView extends Omit<ListeningPort, 'commandLine' | 'ancestors'> {
  /** The command line with secrets blacked out and the home folder as ~. */
  commandLine: string | null
  /** The cockpit session whose agent started the process (it or a parent of it). */
  session: PortSession | null
  /** The cockpit's own: "EML Cockpit", "EML brain server". */
  label: string | null
  /** Runs outside the user's home folder: the system's, not the user's work. */
  system: boolean
}

type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>
type Git = (cwd: string, args: string[]) => Promise<string | null>

const notFound = (json: Json, res: http.ServerResponse, message: string) =>
  json(res, 404, { error: { code: 'NOT_FOUND', message } })

export async function handlePluginsApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PluginsApiDeps,
  url: URL,
  method: string,
  json: Json,
  readJson: ReadJson,
): Promise<boolean> {
  const { pathname } = url
  if (pathname === '/api/notes' || pathname.startsWith('/api/notes/')) {
    if ((await pluginStates()).note) return false
    notFound(json, res, 'Notes are switched off (Settings › EML Plugins)')
    return true
  }
  if (pathname === '/api/plugins') {
    if (method === 'PATCH') {
      const body = await readJson(req)
      if (!isPluginId(body.id) || typeof body.enabled !== 'boolean') {
        json(res, 400, { error: { code: 'BAD_REQUEST', message: `id is one of ${PLUGIN_IDS.join(', ')}, enabled a boolean` } })
        return true
      }
      const { id, enabled } = body
      await updateCockpitConfig((config) => config && { ...config, plugins: { ...config.plugins, [id]: enabled } })
    } else if (method !== 'GET') return false
    const states = await pluginStates()
    json(res, 200, { plugins: PLUGIN_IDS.map((id) => ({ id, enabled: states[id] })) })
    return true
  }
  if (!pathname.startsWith('/api/plugins/worktrees/') || method !== 'GET') return false
  if (!(await pluginStates()).worktrees) {
    notFound(json, res, 'Worktrees is switched off (Settings › EML Plugins)')
    return true
  }
  const what = pathname.slice('/api/plugins/worktrees/'.length)
  if (what === 'ports') {
    const ports = await (deps.ports ?? platform.listeningPorts)()
    json(res, 200, { ports: ports && describePorts(ports, deps) })
    return true
  }
  if (what === 'git') {
    const folder = deps.projectFolder(url.searchParams.get('projectId') ?? '')
    if (!folder) {
      notFound(json, res, 'This project has no folder')
      return true
    }
    json(res, 200, await worktreesGit(folder, deps.git ?? runGit))
    return true
  }
  return false
}

/** Who a port belongs to: a session's process tree, the cockpit itself, the system. */
export function describePorts(ports: ListeningPort[], deps: PluginsApiDeps): PortView[] {
  const home = deps.home ?? os.homedir()
  const sessions = deps.sessionProcesses?.() ?? new Map<number, PortSession>()
  const own = deps.ownPorts?.() ?? new Map<number, string>()
  const atHome = (text: string) => text.split(`${home}/`).join('~/')
  const labelOf = (port: ListeningPort) => own.get(port.port) ?? (port.pid === process.pid ? 'EML Cockpit' : ownProcess(port.commandLine ?? ''))
  // The cockpit hosts among the ports (this one, the installed app, a dev checkout): pid → their port.
  const hosts = new Map(ports.filter((port) => labelOf(port) === 'EML Cockpit').map((port) => [port.pid, port.port]))
  return ports.map((port) => {
    const { ancestors, commandLine, ...rest } = port
    const owner = [port.pid, ...ancestors].find((pid) => sessions.has(pid))
    // A session of a cockpit whose sessions this host doesn't know: its agent runs below that host.
    const host = owner === undefined ? ancestors.find((pid) => hosts.has(pid)) : undefined
    return {
      ...rest,
      commandLine: commandLine && atHome(redactSecrets(commandLine)),
      session: owner === undefined ? null : sessions.get(owner) ?? null,
      label: labelOf(port) ?? (host === undefined ? null : `Session in EML Cockpit :${hosts.get(host)}`),
      system: !port.cwd || !(port.cwd === home || port.cwd.startsWith(`${home}/`)),
    }
  })
}

/** Another cockpit's host or brain server (the installed app, a dev checkout), told by the script it runs. */
function ownProcess(commandLine: string): string | null {
  if (/brain-watchdog\.js|eml-cockpit\/dist\/brain/.test(commandLine)) return 'EML brain server'
  if (/eml-cockpit\/dist\/index\.js|cockpit\/host\/src\/index\.ts|tsx\/dist\/cli\.mjs watch src\/index\.ts/.test(commandLine)) return 'EML Cockpit'
  return null
}

const runGit: Git = (cwd, args) => new Promise((resolve) => {
  execFile('git', ['-C', cwd, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out)))
})

/** The repository's worktrees, each compared with the default branch. */
export async function worktreesGit(folder: string, git: Git): Promise<WorktreesGit> {
  const list = await git(folder, ['worktree', 'list', '--porcelain'])
  if (list === null) return { folder, base: null, worktrees: null }
  const base = await defaultBranch(folder, git)
  const own = await git(folder, ['rev-parse', '--show-toplevel'])
  const projectRoot = own?.trim() ? path.resolve(own.trim()) : path.resolve(folder)
  const worktrees = await Promise.all(parseWorktrees(list).map(async (wt): Promise<Worktree> => {
    const [status, counts, last, ahead, gitDir] = await Promise.all([
      git(wt.path, ['status', '--porcelain']),
      base ? git(wt.path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]) : Promise.resolve(null),
      git(wt.path, ['log', '-1', `--format=${COMMIT_FORMAT}`]),
      base ? git(wt.path, ['log', `-${LISTED}`, `--format=${COMMIT_FORMAT}`, `${base}..HEAD`]) : Promise.resolve(null),
      git(wt.path, ['rev-parse', '--absolute-git-dir']),
    ])
    const [behindCount, aheadCount] = counts?.trim().split(/\s+/).map(Number) ?? []
    const changed = status === null ? [] : status.split('\n').filter(Boolean)
    return {
      ...wt,
      dirty: changed.length,
      changes: changed.slice(0, LISTED).map((line) => ({ code: line.slice(0, 2), path: line.slice(3) })),
      ahead: Number.isInteger(aheadCount) ? aheadCount : null,
      behind: Number.isInteger(behindCount) ? behindCount : null,
      commits: parseCommits(ahead ?? ''),
      lastCommit: parseCommits(last ?? '')[0] ?? null,
      createdAt: await worktreeAdded(gitDir?.trim() ?? ''),
      isProjectFolder: path.resolve(wt.path) === projectRoot,
    }
  }))
  return { folder, base, worktrees }
}

const COMMIT_FORMAT = '%h%x00%s%x00%cI'

function parseCommits(output: string): Commit[] {
  return output.split('\n').filter(Boolean).map((line) => {
    const [hash, subject, at] = line.split('\0')
    return { hash, subject: subject ?? '', at: at ?? '' }
  })
}

/** A linked worktree's git dir is `<repo>/.git/worktrees/<name>`, made by `git worktree add`. */
async function worktreeAdded(gitDir: string): Promise<string | null> {
  if (path.basename(path.dirname(gitDir)) !== 'worktrees') return null
  try {
    const stat = await fs.stat(gitDir)
    return (stat.birthtimeMs > 0 ? stat.birthtime : stat.ctime).toISOString()
  } catch {
    return null
  }
}

/** origin's default branch when there is a remote, else a local main or master. */
async function defaultBranch(folder: string, git: Git): Promise<string | null> {
  const remote = (await git(folder, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim()
  if (remote) return remote
  for (const name of ['main', 'master']) {
    if (await git(folder, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) !== null) return name
  }
  return null
}

/** `git worktree list --porcelain`: blocks of `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>` | `detached`. */
export function parseWorktrees(output: string): Array<Pick<Worktree, 'path' | 'branch' | 'head'>> {
  return output.split('\n\n').flatMap((block) => {
    const lines = block.split('\n')
    const field = (key: string) => lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1)
    const wtPath = field('worktree')
    if (!wtPath || lines.includes('bare')) return []
    const branch = field('branch')
    return [{ path: wtPath, branch: branch ? branch.replace(/^refs\/heads\//, '') : null, head: field('HEAD') ?? '' }]
  })
}
