import type * as http from 'node:http'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readCockpitConfig, updateCockpitConfig } from './config.js'
import { partsOf, type McpPart, type PluginManifest } from './domain/plugin-manifest.js'
import { PluginRegistry } from './infrastructure/plugins/plugin-registry.js'
import { CUSTOM_PLUGINS_FILE, OFFICIAL_PLUGINS_DIR } from './paths.js'
import { redactSecrets } from './diagnostics/redact.js'
import type { ListeningPort } from './domain/platform.js'
import { platform } from './infrastructure/platform/index.js'
import { handleRepositoryApi } from './plugins-repository.js'
import { isLocalRequest, readRemoteAccess } from './remote-access.js'
import type { Place, TimeTracker } from './time-tracking.js'

/** Names by space id ('' for the main space), by projectKey and by task id; null when unknown. */
export interface TimeNames {
  spaces: Record<string, string>
  projects: Record<string, string | null>
  tasks: Record<string, string | null>
}

/**
 * The cockpit's plugins (plan cockpit-plugins-mcp-channels-plan): the official
 * ones in plugins/<id>/plugin.json — the project's views, Brain among them, and
 * services such as Gmail — and the user's own custom MCP servers
 * (infrastructure/plugins/plugin-registry.ts). Settings › EML Plugins switches
 * them on or off for the whole cockpit — every browser of it sees the same.
 * Brain off hides only the pane view; the brain itself and the header's Brain tab stay.
 * A plugin's manifest says whether it starts on (defaultEnabled: Brain, Note
 * and Worktrees, decision cockpit-plugin-defaults); the user's own switch wins.
 *
 *   GET    /api/plugins                         → { plugins: [PluginView] }
 *   PATCH  /api/plugins  { id, enabled }        → the same, after the change
 *   POST   /api/plugins/custom  { id, name, description?, parts: { mcp } } → { plugin }, this machine only
 *   DELETE /api/plugins/custom/<id>             → { removed }, this machine only
 *   GET    /api/plugins/worktrees/git?projectId= → the project folder's worktrees
 *   GET    /api/plugins/worktrees/ports          → the ports the user's processes listen on
 *   GET    /api/plugins/repository/…            → a checkout's diffs, files and commits (plugins-repository.ts)
 *   DELETE /api/plugins/shell/<id>              → end a Shell plugin terminal (its pane closed)
 *   POST   /api/plugins/time/beat { spaceId, projectId, sessionId, fresh? } → the user is at the cockpit (time-tracking.ts)
 *   GET    /api/plugins/time?days=              → the last days' times, today last, and the sessions' names
 *
 * The Worktrees routes read only: the folder comes from the project registry,
 * never from the request, so a caller can't point them at another path. They
 * are shaped like the capabilities a sandboxed plugin would later call
 * (cockpit-plugin-system-implementation-plan). A plugin that is off answers
 * 404 on its routes, Notes included (/api/notes).
 */

export const pluginRegistry = new PluginRegistry({
  officialDir: OFFICIAL_PLUGINS_DIR,
  customFile: CUSTOM_PLUGINS_FILE,
  log: (line) => console.log(line),
})

/** What the user chose, else the plugin's default; every plugin the registry knows. */
export async function pluginStates(registry: PluginRegistry = pluginRegistry): Promise<Record<string, boolean>> {
  const chosen = (await readCockpitConfig())?.plugins ?? {}
  return Object.fromEntries((await registry.list()).map((manifest) => [manifest.id, chosen[manifest.id] ?? manifest.defaultEnabled]))
}

/** A plugin as the page sees it: never a value an MCP part passes, only the names. */
export interface PluginView {
  id: string
  name: string
  description: string
  tier: PluginManifest['tier']
  parts: Array<'pane' | 'mcp' | 'channel'>
  /** The built-in view its pane shows. */
  pane: string | null
  /** The bridge account type its channel serves. */
  channel: string | null
  mcp: { transport: McpPart['transport']; target: string; settings: Array<{ name: string; secret: boolean }> } | null
  auth: PluginManifest['auth'] | null
  enabled: boolean
}

export function pluginView(manifest: PluginManifest, enabled: boolean): PluginView {
  const { pane, mcp, channel } = manifest.parts
  const settings = mcp ? Object.entries(mcp.transport === 'stdio' ? mcp.env : mcp.headers).map(([name, value]) => ({ name, secret: typeof value !== 'string' })) : []
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    tier: manifest.tier,
    parts: partsOf(manifest),
    pane: pane && 'builtin' in pane ? pane.builtin : null,
    channel: channel?.adapter ?? null,
    // The command without its arguments: they may carry a token.
    mcp: mcp ? { transport: mcp.transport, target: mcp.transport === 'stdio' ? mcp.command : new URL(mcp.url).origin, settings } : null,
    auth: manifest.auth ?? null,
    enabled,
  }
}

async function pluginViews(registry: PluginRegistry): Promise<PluginView[]> {
  const states = await pluginStates(registry)
  return (await registry.list()).map((manifest) => pluginView(manifest, states[manifest.id] ?? false))
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
  /** The plugins; the cockpit's own registry when left out. */
  registry?: PluginRegistry
  /** The pane project's folder in the request's space; null: no such project or no folder. */
  projectFolder: (projectId: string) => string | null
  /** The cockpit sessions' running agent processes, pid → session. */
  sessionProcesses?: () => Map<number, PortSession>
  /** Ports the cockpit itself serves, port → what they are ("EML brain server"). */
  ownPorts?: () => Map<number, string>
  ports?: () => Promise<ListeningPort[] | null>
  /** End the Shell plugin's terminal `id` (pty-bridge.ts); whether one ran. */
  endShell?: (id: string) => boolean
  endShells?: () => number
  time?: TimeTracker
  /** What the sidebar calls a session; null when it has no name yet. */
  sessionName?: (sessionId: string) => string | null
  /** The names of the Time view's spaces, projects and tasks, each looked up in its own space. */
  timeNames?: (refs: { projects: Place[]; tasks: Array<{ spaceId: string | null; taskId: string }> }) => Promise<TimeNames>
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

export type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>
export type Git = (cwd: string, args: string[]) => Promise<string | null>

export const notFound = (json: Json, res: http.ServerResponse, message: string) =>
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
  const registry = deps.registry ?? pluginRegistry
  if (pathname === '/api/notes' || pathname.startsWith('/api/notes/')) {
    if ((await pluginStates(registry)).note) return false
    notFound(json, res, 'Notes are switched off (Settings › EML Plugins)')
    return true
  }
  if (pathname === '/api/plugins') {
    if (method === 'PATCH') {
      const body = await readJson(req)
      const known = typeof body.id === 'string' && (await registry.get(body.id)) !== null
      if (!known || typeof body.enabled !== 'boolean') {
        json(res, 400, { error: { code: 'BAD_REQUEST', message: 'id is a plugin this cockpit knows, enabled a boolean' } })
        return true
      }
      const id = body.id as string
      const enabled = body.enabled
      await updateCockpitConfig((config) => config && { ...config, plugins: { ...config.plugins, [id]: enabled } })
      // A shell switched off ends with it, not only at its detach timeout.
      if (id === 'shell' && !enabled) deps.endShells?.()
    } else if (method !== 'GET') return false
    json(res, 200, { plugins: await pluginViews(registry) })
    return true
  }
  if (pathname === '/api/plugins/custom' || pathname.startsWith('/api/plugins/custom/')) {
    // A custom MCP server runs with the user's rights in every session that gets it: set up on this machine only.
    if (!isLocalRequest(req)) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Custom MCP servers are added and removed on this machine only' } })
      return true
    }
    if (pathname === '/api/plugins/custom' && method === 'POST') {
      const result = await registry.addCustom(await readJson(req))
      if (!result.ok) {
        json(res, 400, { error: { code: 'BAD_REQUEST', message: result.reason } })
        return true
      }
      json(res, 201, { plugin: pluginView(result.manifest, (await pluginStates(registry))[result.manifest.id] ?? false) })
      return true
    }
    const customId = /^\/api\/plugins\/custom\/([a-z][a-z0-9-]{0,39})$/.exec(pathname)?.[1]
    if (customId && method === 'DELETE') {
      const removed = await registry.removeCustom(customId)
      if (removed) await updateCockpitConfig((config) => config && { ...config, plugins: Object.fromEntries(Object.entries(config.plugins ?? {}).filter(([id]) => id !== customId)) })
      json(res, removed ? 200 : 404, removed ? { removed: true } : { error: { code: 'NOT_FOUND', message: 'No custom plugin with this id' } })
      return true
    }
    return false
  }
  // The Shell plugin's terminal runs over the terminal socket (pty-bridge.ts); its pane closed, it ends here.
  const shellId = /^\/api\/plugins\/shell\/([a-zA-Z0-9_.\-:]+)$/.exec(pathname)?.[1]
  if (shellId && method === 'DELETE') {
    // Who may open a shell may end one: this machine, remotely only with `eml-cockpit remote shell on`.
    if (!isLocalRequest(req) && !readRemoteAccess().shell) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'The shell is ended on this machine only' } })
      return true
    }
    json(res, 200, { ended: deps.endShell?.(shellId) ?? false })
    return true
  }
  if (pathname === '/api/plugins/time' || pathname === '/api/plugins/time/beat') {
    if (!deps.time) return false
    if (!(await pluginStates(registry)).time) {
      notFound(json, res, 'Time is switched off (Settings › EML Plugins)')
      return true
    }
    if (pathname === '/api/plugins/time/beat' && method === 'POST') {
      const body = await readJson(req)
      // Ids as the cockpit makes them; anything else counts as none.
      const id = (value: unknown) => (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null)
      await deps.time.beat({ spaceId: id(body.spaceId), projectId: id(body.projectId), sessionId: id(body.sessionId) }, body.fresh === true)
      json(res, 200, { ok: true })
      return true
    }
    if (pathname !== '/api/plugins/time' || method !== 'GET') return false
    const days = deps.time.days(Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 31))
    const ids = new Set(days.flatMap((day) => Object.keys(day.sessions)))
    const sessions = Object.fromEntries([...ids].map((sid) => [sid, deps.sessionName?.(sid) ?? null]))
    const projects = [...new Map(days.flatMap((day) => Object.entries(day.projects))).values()]
    const tasks = [...new Map(days.flatMap((day) => Object.entries(day.tasks))).entries()].map(([taskId, t]) => ({ spaceId: t.spaceId, taskId }))
    const names = (await deps.timeNames?.({ projects, tasks })) ?? { spaces: {}, projects: {}, tasks: {} }
    json(res, 200, { days, names: { ...names, sessions } })
    return true
  }
  if (pathname.startsWith('/api/plugins/repository/') && method === 'GET') {
    if (!(await pluginStates(registry)).repository) {
      notFound(json, res, 'Repository is switched off (Settings › EML Plugins)')
      return true
    }
    return handleRepositoryApi(res, deps, url, json)
  }
  if (!pathname.startsWith('/api/plugins/worktrees/') || method !== 'GET') return false
  if (!(await pluginStates(registry)).worktrees) {
    notFound(json, res, 'Worktrees is switched off (Settings › EML Plugins)')
    return true
  }
  const what = pathname.slice('/api/plugins/worktrees/'.length)
  if (what === 'ports') {
    // Every local process's command line: for this machine, not for a remote viewer.
    if (!isLocalRequest(req)) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'The port list is shown on this machine only' } })
      return true
    }
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
  // Either separator: Windows command lines may write the home folder with / or \.
  const atHome = (text: string) => [`${home}/`, `${home}\\`].reduce((out, prefix) => out.split(prefix).join(`~${prefix.slice(-1)}`), text)
  const inHome = (folder: string) => {
    const rel = path.relative(home, folder)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }
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
      system: !port.cwd || !inHome(port.cwd),
    }
  })
}

/** Another cockpit's host or brain server (the installed app, a dev checkout), told by the script it runs. */
function ownProcess(commandLine: string): string | null {
  if (/brain-watchdog\.js|eml-cockpit\/dist\/brain/.test(commandLine)) return 'EML brain server'
  if (/eml-cockpit\/dist\/index\.js|cockpit\/host\/src\/index\.ts|tsx\/dist\/cli\.mjs watch src\/index\.ts/.test(commandLine)) return 'EML Cockpit'
  return null
}

// --no-optional-locks: git status would otherwise refresh the index and hold
// index.lock for a moment, and an agent's git add or commit in that worktree
// at the same moment would fail.
export const gitRunner = (maxBuffer: number): Git => (cwd, args) => new Promise((resolve) => {
  execFile('git', ['--no-optional-locks', '-C', cwd, ...args], { timeout: 10_000, maxBuffer }, (err, out) => resolve(err ? null : String(out)))
})

const runGit = gitRunner(4 * 1024 * 1024)

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
export async function defaultBranch(folder: string, git: Git): Promise<string | null> {
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
    // git writes / on every OS; the system's own form matches the folders the hooks report.
    return [{ path: path.resolve(wtPath), branch: branch ? branch.replace(/^refs\/heads\//, '') : null, head: field('HEAD') ?? '' }]
  })
}
