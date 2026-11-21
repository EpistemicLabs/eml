import type * as http from 'node:http'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { partsOf, type McpPart, type PluginManifest } from './domain/plugin-manifest.js'
import { PluginRegistry } from './infrastructure/plugins/plugin-registry.js'
import { PluginStore } from './infrastructure/plugins/plugin-store.js'
import { GoogleSignIn } from './infrastructure/plugins/google-sign-in.js'
import type { OutsideServer } from './infrastructure/plugins/outside-servers.js'
import { SpacePluginService } from './application/space-plugins.js'
import { connectionSchema, PART_KINDS, spacesOf, type SpacePlugins } from './domain/space-plugins.js'
import { CUSTOM_PLUGINS_FILE, HOST_ROOT, OFFICIAL_PLUGINS_DIR, PLUGINS_HOME } from './paths.js'
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
 * (infrastructure/plugins/plugin-registry.ts). Each space has its own: a plugin
 * is on or off per space, all or nothing, with one of the user's connections
 * where it needs a sign-in (application/space-plugins.ts). A space's sessions
 * start with exactly the MCP servers of its plugins, and without the claude.ai
 * connectors and Claude Code plugin servers switched off in it. Brain off hides
 * only the pane view; the brain itself and the header's Brain tab stay.
 *
 *   GET    /api/plugins?space=                  → { plugins: [PluginView] }, enabled for that space
 *   PATCH  /api/plugins  { id, enabled, space?, connections? } → in one space (with the sign-ins it uses), or every open one
 *   PATCH  /api/plugins/parts  { id, part, enabled } → a part off or on for every space
 *   DELETE /api/plugins/import-notice           → the user has seen the notice about the imported servers
 *   GET    /api/plugins/outside                 → { servers: [{ name, kind, off: [space] }] }
 *   PATCH  /api/plugins/outside  { space, server, enabled } → a connector off or on in a space
 *   GET    /api/plugins/connections             → { connections: [{ id, plugin, label, secrets }] }
 *   POST   /api/plugins/connections  { plugin, label, values } → { connection }
 *   DELETE /api/plugins/connections/<id>        → { removed }
 *   GET|PUT /api/plugins/google/client  { client } → { configured }: the user's own Google OAuth client
 *   POST   /api/plugins/google/sign-in  { plugin } → { url }: Google's consent page
 *   POST   /api/plugins/google/sign-in/finish  { plugin, redirect, slug? } → { connection }
 *   POST   /api/plugins/custom  { id, name, description?, parts: { mcp } } → { plugin }, remotely only with the shell on
 *   DELETE /api/plugins/custom/<id>             → { removed }, remotely only with the shell on
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
 * (cockpit-plugin-system-implementation-plan). A pane plugin off in every
 * space answers 404 on its routes, Notes included (/api/notes).
 */

export const pluginRegistry = new PluginRegistry({
  officialDir: OFFICIAL_PLUGINS_DIR,
  customFile: CUSTOM_PLUGINS_FILE,
  log: (line) => console.log(line),
})

/** Which plugin is on in which space, and the user's connections (owner-only, <home>/plugins/). */
export const pluginStore = new PluginStore(PLUGINS_HOME)
export const spacePlugins = new SpacePluginService(pluginRegistry, pluginStore, { NODE: process.execPath, COCKPIT_DIST: path.join(HOST_ROOT, 'dist') })

/** Google sign-ins with the user's own OAuth client (<home>/plugins/google/, owner-only). */
export const googleSignIn = new GoogleSignIn({ dir: path.join(PLUGINS_HOME, 'google') })

/** The registry and the per-space state a request works on; the cockpit's own unless a test hands its own. */
export interface PluginsContext {
  registry: PluginRegistry
  service: SpacePluginService
  store: PluginStore
  google?: GoogleSignIn
}
const defaultContext: PluginsContext = { registry: pluginRegistry, service: spacePlugins, store: pluginStore, google: googleSignIn }

/** Whether each plugin is on in any space: the gate of a pane's routes, which serve every space. */
export async function pluginStates(ctx: PluginsContext = defaultContext): Promise<Record<string, boolean>> {
  const state = await ctx.store.spaces()
  return Object.fromEntries((await ctx.registry.list()).map((manifest) => [manifest.id, spacesOf(state, manifest.id).length > 0]))
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
  /** On in the space the page asked about (or in any space, when it named none). */
  enabled: boolean
  /** Space id → the sign-ins it uses there, for every space it is on in. */
  spaces: Record<string, string[]>
  /** Its parts switched off for every space. */
  partsOff: Array<'pane' | 'mcp' | 'channel'>
  /** Made by the one-time import of the servers configured outside the plugins. */
  imported: boolean
}

export function pluginView(manifest: PluginManifest, state: SpacePlugins, space: string | null): PluginView {
  const spaces = Object.fromEntries(spacesOf(state, manifest.id).map((id) => [id, state.spaces[id]?.plugins[manifest.id]?.connections ?? []]))
  const enabled = space === null ? Object.keys(spaces).length > 0 : space in spaces
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
    mcp: mcp ? { transport: mcp.transport, target: mcpTarget(mcp), settings } : null,
    auth: manifest.auth ?? null,
    enabled,
    spaces,
    partsOff: state.partsOff[manifest.id] ?? [],
    imported: state.imported.includes(manifest.id),
  }
}

/** What an MCP part runs or reaches, for the page: a command, a bundled server's file, or a URL's origin. */
function mcpTarget(mcp: McpPart): string {
  if (mcp.transport !== 'stdio') return typeof mcp.url === 'string' ? new URL(mcp.url).origin : 'a URL kept as a secret'
  const first = mcp.args[0]
  return mcp.command.startsWith('${') && typeof first === 'string' ? path.basename(first) : mcp.command
}

async function pluginViews(ctx: PluginsContext, space: string | null): Promise<PluginView[]> {
  const state = await ctx.store.spaces()
  return (await ctx.registry.list()).map((manifest) => pluginView(manifest, state, space))
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
  /** The plugins and their per-space state; the cockpit's own when left out. */
  plugins?: PluginsContext
  /** The ids of the open spaces: a switch without a space applies to all of them. */
  spaceIds?: () => string[]
  /** The claude.ai connectors and Claude Code plugin servers a space can switch off. */
  outside?: { list(): Promise<OutsideServer[]> }
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
  const ctx = deps.plugins ?? defaultContext
  const { registry, service } = ctx
  if (pathname === '/api/notes' || pathname.startsWith('/api/notes/')) {
    if ((await pluginStates(ctx)).note) return false
    notFound(json, res, 'Notes are switched off (Settings › EML Plugins)')
    return true
  }
  const badRequest = (message: string) => { json(res, 400, { error: { code: 'BAD_REQUEST', message } }); return true }
  if (pathname === '/api/plugins') {
    let space = url.searchParams.get('space')
    if (method === 'PATCH') {
      // { id, enabled, space?, connection? }: on or off in one space, or in every open space without one.
      const body = await readJson(req)
      const known = typeof body.id === 'string' && (await registry.get(body.id)) !== null
      if (!known || typeof body.enabled !== 'boolean') return badRequest('id is a plugin this cockpit knows, enabled a boolean')
      if (body.space !== undefined && typeof body.space !== 'string') return badRequest('space is a space id')
      // `connections` (the sign-ins it uses there) or, as before, one `connection`.
      const picked = Array.isArray(body.connections) ? body.connections : body.connection === undefined ? undefined : body.connection === null ? [] : [body.connection]
      if (picked !== undefined && !picked.every((c): c is string => typeof c === 'string')) return badRequest('connections is a list of connection ids')
      const id = body.id as string
      space = typeof body.space === 'string' ? body.space : null
      const targets = space !== null ? [space] : (deps.spaceIds?.() ?? [])
      for (const target of targets) {
        const result = await service.setPlugin(target, id, body.enabled, picked)
        if (!result.ok) return badRequest(result.reason)
      }
      // A shell switched off everywhere ends with it, not only at its detach timeout.
      if (id === 'shell' && !body.enabled && !(await pluginStates(ctx)).shell) deps.endShells?.()
    } else if (method !== 'GET') return false
    const state = await ctx.store.spaces()
    // The notice about the import, until the user has seen it: how many servers became plugins.
    const importNotice = !state.importNoticeDone && state.imported.length > 0 ? { count: state.imported.length } : null
    json(res, 200, { plugins: await pluginViews(ctx, space), importNotice })
    return true
  }
  if (pathname === '/api/plugins/import-notice' && method === 'DELETE') {
    await ctx.store.updateSpaces((state) => ({ ...state, importNoticeDone: true }))
    json(res, 200, { importNotice: null })
    return true
  }
  if (pathname === '/api/plugins/parts' && method === 'PATCH') {
    const body = await readJson(req)
    if (typeof body.id !== 'string' || !(await registry.get(body.id)) || !(PART_KINDS as readonly unknown[]).includes(body.part) || typeof body.enabled !== 'boolean') {
      return badRequest('id is a plugin, part one of pane, mcp, channel, enabled a boolean')
    }
    await service.setPart(body.id, body.part as 'pane' | 'mcp' | 'channel', body.enabled)
    json(res, 200, { plugins: await pluginViews(ctx, null) })
    return true
  }
  if (pathname === '/api/plugins/outside') {
    // The claude.ai connectors and Claude Code plugin servers, and the spaces each is off in.
    if (method === 'PATCH') {
      const body = await readJson(req)
      if (typeof body.space !== 'string' || typeof body.server !== 'string' || typeof body.enabled !== 'boolean') return badRequest('space, server and enabled are needed')
      await service.setOutside(body.space, body.server, body.enabled)
    } else if (method !== 'GET') return false
    const state = await ctx.store.spaces()
    const known = await (deps.outside?.list() ?? Promise.resolve([]))
    const names = new Set([...known.map((s) => s.name), ...Object.values(state.spaces).flatMap((s) => s.off)])
    json(res, 200, {
      servers: [...names].sort().map((name) => ({
        name,
        kind: known.find((s) => s.name === name)?.kind ?? (name.startsWith('plugin:') ? 'claude-plugin' : 'connector'),
        off: Object.entries(state.spaces).filter(([, s]) => s.off.includes(name)).map(([id]) => id),
      })),
    })
    return true
  }
  if (pathname.startsWith('/api/plugins/google/') && ctx.google) {
    // A Google sign-in with the user's own OAuth client: the client once, then consent and the
    // address the browser ended on (google-sign-in.ts). Like the connections, for the user's own logins.
    const google = ctx.google
    if (pathname === '/api/plugins/google/client') {
      // A sign-in made before (e.g. the bridge's accounts file) names the client it was made with.
      const fromSignIns = (await service.connections()).filter((c) => c.values.credentialsFile && c.values.credentialsFile !== google.clientFile)
      if (method === 'PUT') {
        const body = await readJson(req)
        const from = typeof body.fromConnection === 'string' ? fromSignIns.find((c) => c.id === body.fromConnection) : undefined
        let client: unknown = body.client
        if (from) {
          try {
            client = await fs.readFile(from.values.credentialsFile, 'utf8')
          } catch {
            return badRequest('The client file of that sign-in cannot be read')
          }
        }
        const saved = await google.saveClient(client)
        if (!saved.ok) return badRequest(saved.reason)
      } else if (method !== 'GET') return false
      json(res, 200, { configured: (await google.client()) !== null, fromSignIns: fromSignIns.map((c) => ({ id: c.id, label: c.label })) })
      return true
    }
    if (pathname === '/api/plugins/google/sign-in' && method === 'POST') {
      const body = await readJson(req)
      const manifest = typeof body.plugin === 'string' ? await registry.get(body.plugin) : null
      if (!manifest || manifest.auth?.kind !== 'google-oauth') return badRequest('plugin is a plugin that signs in with Google')
      // Signed in again, a mailbox gets a token file of its own in the cockpit home: a file another
      // program keeps (a sign-in made before the plugins) is never written. finish matches it by address.
      const started = await google.start(manifest.auth.scopes)
      if (!started.ok) return badRequest(started.reason)
      json(res, 200, { url: started.url })
      return true
    }
    if (pathname === '/api/plugins/google/sign-in/finish' && method === 'POST') {
      const body = await readJson(req)
      if (typeof body.plugin !== 'string' || !(await registry.get(body.plugin)) || typeof body.redirect !== 'string') return badRequest('plugin and redirect (the address the browser ended on) are needed')
      if (body.slug !== undefined && (typeof body.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,23}$/.test(body.slug))) return badRequest('the short name is lower case letters, digits and dashes')
      const finished = await google.finish(body.redirect)
      if (!finished.ok) return badRequest(finished.reason)
      const { address, credentialsFile, tokenFile } = finished.signedIn
      const all = await service.connections()
      const again = all.find((c) => c.plugin === body.plugin && c.values.address?.toLowerCase() === address.toLowerCase())
      // An id that doesn't name the mailbox: it shows up in logs and file names.
      const id = again?.id ?? `${body.plugin}-${randomUUID().slice(0, 8)}`
      const connection = { id, plugin: body.plugin, label: address, ...(typeof body.slug === 'string' ? { slug: body.slug } : again?.slug ? { slug: again.slug } : {}), values: { address, credentialsFile, tokenFile } }
      await service.saveConnection(connection)
      json(res, 200, { connection: { id, plugin: connection.plugin, label: address, slug: connection.slug ?? null, secrets: Object.keys(connection.values), again: !!again } })
      return true
    }
    return false
  }
  if (pathname === '/api/plugins/connections' || pathname.startsWith('/api/plugins/connections/')) {
    // Sign-ins and secrets: set up by the user here or through remote access (remote.json lets
    // only the user's own tailnet logins in); their values are never sent back.
    if (pathname === '/api/plugins/connections' && method === 'GET') {
      json(res, 200, { connections: (await service.connections()).map(({ values, ...rest }) => ({ ...rest, slug: rest.slug ?? null, secrets: Object.keys(values), address: values.address ?? null })) })
      return true
    }
    if (pathname === '/api/plugins/connections' && method === 'POST') {
      const body = await readJson(req)
      if (typeof body.plugin !== 'string' || !(await registry.get(body.plugin))) return badRequest('plugin is a plugin this cockpit knows')
      const id = `${body.plugin}-${randomUUID().slice(0, 8)}`
      const parsed = connectionSchema.safeParse({ id, plugin: body.plugin, label: body.label ?? '', ...(body.slug ? { slug: body.slug } : {}), values: body.values ?? {} })
      if (!parsed.success) return badRequest('label is a short text, values maps names to strings')
      await service.saveConnection(parsed.data)
      json(res, 201, { connection: { id, plugin: parsed.data.plugin, label: parsed.data.label, secrets: Object.keys(parsed.data.values) } })
      return true
    }
    const connectionId = /^\/api\/plugins\/connections\/([a-z0-9][a-z0-9-]{0,62})$/.exec(pathname)?.[1]
    if (connectionId && method === 'DELETE') {
      const gone = (await service.connections()).find((c) => c.id === connectionId)
      const removed = await service.removeConnection(connectionId)
      // A token file the cockpit wrote for the sign-in goes with it; one another program keeps stays.
      const tokenFile = gone?.values.tokenFile
      if (removed && tokenFile && ctx.google && path.dirname(path.resolve(tokenFile)) === path.resolve(path.dirname(ctx.google.clientFile))) {
        await fs.rm(tokenFile, { force: true })
      }
      json(res, removed ? 200 : 404, removed ? { removed: true } : { error: { code: 'NOT_FOUND', message: 'No connection with this id' } })
      return true
    }
    return false
  }
  if (pathname === '/api/plugins/custom' || pathname.startsWith('/api/plugins/custom/')) {
    // A custom MCP server runs a command with the user's rights, as a shell would: from elsewhere only
    // where the Shell plugin may open too (`eml-cockpit remote shell on`).
    if (!isLocalRequest(req) && !readRemoteAccess().shell) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Custom MCP servers are added on the cockpit\'s machine, or remotely after `eml-cockpit remote shell on`' } })
      return true
    }
    if (pathname === '/api/plugins/custom' && method === 'POST') {
      const body = await readJson(req)
      const parts = body.parts && typeof body.parts === 'object' ? Object.keys(body.parts) : []
      // "Add custom MCP": an MCP server only. A custom plugin with a pane comes from promoting a community one.
      if (parts.some((part) => part !== 'mcp')) return badRequest('A custom MCP plugin has an mcp part only')
      const result = await registry.addCustom(body)
      if (!result.ok) return badRequest(result.reason)
      json(res, 201, { plugin: pluginView(result.manifest, await ctx.store.spaces(), null) })
      return true
    }
    const customId = /^\/api\/plugins\/custom\/([a-z][a-z0-9-]{0,39})$/.exec(pathname)?.[1]
    if (customId && method === 'DELETE') {
      const removed = await registry.removeCustom(customId)
      if (removed) await service.forget(customId)
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
    if (!(await pluginStates(ctx)).time) {
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
    if (!(await pluginStates(ctx)).repository) {
      notFound(json, res, 'Repository is switched off (Settings › EML Plugins)')
      return true
    }
    return handleRepositoryApi(res, deps, url, json)
  }
  if (!pathname.startsWith('/api/plugins/worktrees/') || method !== 'GET') return false
  if (!(await pluginStates(ctx)).worktrees) {
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
