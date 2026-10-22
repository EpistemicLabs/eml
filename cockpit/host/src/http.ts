import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WebSocketServer } from 'ws'
import { attachSpawnEvents, handleSpawnApi } from './spawn-api.js'
import type { SpawnQueue } from './spawn-queue.js'
import { CONFIG_DIR, FRONTEND_DIST, HOST_ROOT, COCKPIT_FOLDERS_DIR } from './paths.js'
import type { PtyBridge } from './pty-bridge.js'
import { spaceView, openBrainSpace, type BrainSpace, type BrainSpaces } from './brain-space.js'
import { provisionSpace } from './provision.js'
import {
  ProjectPathError,
  browseFolders,
  createFolder,
  brainIdFromProjectId,
  projectIdForBrain,
  type ProjectEntry,
  type ProjectRegistry,
} from './project-registry.js'
import { BrainRenameError, type BrainProject } from './brain-projects.js'
import { HOOK_SESSION_HEADER, HOOK_TOKEN_HEADER } from './domain/agent-provider.js'
import type { ProviderRegistry } from './infrastructure/providers/registry.js'
import { applySessionHook } from './application/apply-session-hook.js'
import { isProviderId, writeDefaultProvider } from './provider-settings.js'
// Settings › Models › Claude sign-in and About still speak Claude Code's own
// shapes (login modes, its version); everything else about an agent CLI goes
// through /api/providers.
import { claudeVersion } from './infrastructure/providers/claude/isolation.js'
import type { TurnEvent, TurnTracker } from './turn-state.js'
import { claudeLoginStatus, clearClaudeLogin, invalidateAccountCache, writeAgentPatch, writeClaudeLogin } from './infrastructure/providers/claude/login.js'
import { createBackup, listBackups, readBrainInfo, revealBrainFile } from './brain-info.js'
import { PasteImageError, savePastedImage } from './paste-images.js'
import { acknowledgeUpdateStatus, readUpdateStatus } from './update-status.js'
import { applyUpdate, checkForUpdate, readAppUpdateStatus, rollbackUpdate, writeGithubToken } from './app-update.js'
import { handleNotesApi, type NotesChange } from './notes-api.js'
import { queueSignInSession } from './onboarding.js'
import { readCockpitConfig } from './config.js'
import type { BrainHygiene } from './brain-hygiene.js'

/**
 * The host's public surface (loopback only): static Vite assets, the /api/brain
 * proxy (Bearer injected host-side — the browser never sees the token), the
 * project + session control-plane API the sidebar reads, the POST /api/pty nonce-mint, and the guarded /ws/shell
 * upgrade.
 */


// Settings › About: versions + the isolated config dir. Read once — none
// of it changes while the host runs, except the cockpit's Claude Code version
// (it updates itself; read per request). runMode is 'dev' when the host runs
// from source via `pnpm cockpit:dev` (EML_COCKPIT_DEV=1) — the header shows a
// DEV badge so a dev cockpit is never mistaken for the production one.
export const ABOUT = (() => {
  let version = '0.0.0'
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HOST_ROOT, 'package.json'), 'utf8')) as { version?: string }
    if (typeof pkg.version === 'string') version = pkg.version
  } catch { /* keep the fallback */ }
  const runMode: 'dev' | 'prod' = process.env.EML_COCKPIT_DEV === '1' ? 'dev' : 'prod'
  return { version, runMode, configDir: CONFIG_DIR, node: process.version }
})()

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
}

export interface HostDeps {
  /**
   * The brain spaces (brain-space.ts). A request names its space in the
   * `x-cockpit-space` header; without one it means the main space.
   */
  spaces: BrainSpaces
  bridge: PtyBridge
  turns: TurnTracker
  /** The agent CLIs sessions run with. */
  providers: ProviderRegistry
  /** Per-boot secret the session hooks send (HOOK_TOKEN_HEADER) — POST /api/hook requires it. */
  hookToken: string
  /** The turn-state hook's config of this boot — a new space's session files name it. */
  turnHookConfig: string
  /** Worker-session requests from sessions (spawn-api.ts). */
  spawns: SpawnQueue
  /** Per-boot secret sessions send with POST /api/spawn. */
  spawnToken: string
  /** The brain-hygiene offer of the open space (brain-hygiene.ts). */
  hygiene: BrainHygiene
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req)
  if (!body.length) return {}
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function fail(res: http.ServerResponse, err: unknown): void {
  if (err instanceof ProjectPathError) {
    const status = err.code === 'NOT_FOUND' ? 404 : 400
    json(res, status, { error: { code: err.code, message: err.message } })
    return
  }
  json(res, 500, { error: { code: 'INTERNAL', message: (err as Error).message } })
}

/** Settings › Models: every provider with its runtime, sign-in and settings. */
async function providerViews(deps: HostDeps) {
  const preferred = deps.providers.default().id
  return Promise.all(deps.providers.all().map(async (provider) => ({
    id: provider.id,
    label: provider.label,
    version: provider.runtime.version(),
    problem: provider.runtime.problem(),
    problemHint: provider.runtime.problemHint,
    runtime: provider.runtime.state(),
    signedIn: await provider.auth.signedIn().catch(() => false),
    isDefault: provider.id === preferred,
    settings: provider.settings?.read() ?? null,
  })))
}

/** A project folder is opened by sessions of any provider — none of them should ask about trust. */
function trustProject(deps: HostDeps, projectPath: string): void {
  for (const provider of deps.providers.all()) provider.trustProject(projectPath)
}

// ── Project + session views ───────────────────────
function sessionView(deps: HostDeps, project: ProjectEntry | undefined, entry: ReturnType<PtyBridge['ledger']['list']>[number]) {
  const summary = deps.providers.forSession(entry.sessionId).summary(deps.bridge.ledger.ref(entry.sessionId, project?.path ?? null))
  // The last real message, not the last reattach: a reload or a click on a
  // pane bumps lastAttached and would show every open session as "<1m".
  const lastActivity = summary.lastMessageAt ?? summary.lastActivity ?? entry.createdAt
  return {
    id: entry.sessionId,
    projectId: entry.projectId,
    // `summary` is the display name. A user-chosen title wins, then the
    // title the agent gave the session, then Claude Code's own session
    // title, then the first user prompt.
    summary: entry.title ?? entry.agentTitle ?? summary.aiTitle ?? summary.summary ?? '',
    title: entry.title,
    createdAt: entry.createdAt,
    lastActivity,
    messageCount: summary.messageCount,
    lastMessageAt: summary.lastMessageAt,
    model: summary.model,
    contextTokens: summary.contextTokens,
    isPinned: entry.pinned,
    paneId: entry.paneId,
    taskId: entry.taskId,
    state: deps.bridge.sessionState(entry.sessionId),
    turnState: deps.turns.get(entry.sessionId)?.state ?? 'idle',
    turnSince: deps.turns.get(entry.sessionId)?.since ?? null,
    __provider: deps.providers.forSession(entry.sessionId).id,
    __projectId: entry.projectId ?? undefined,
  }
}

/** Where a project's folder comes from: linked by the user, made by the cockpit, or none yet. */
function folderKind(project: ProjectEntry): 'user' | 'cockpit' | 'none' {
  if (!project.path) return 'none'
  const rel = path.relative(COCKPIT_FOLDERS_DIR, project.path)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? 'cockpit' : 'user'
}

function projectView(deps: HostDeps, space: BrainSpace, project: ProjectEntry, brain: BrainProject | null = null) {
  const sessions = deps.bridge.ledger.list(project.projectId, space.ledgerKey)
    .map((entry) => sessionView(deps, project, entry))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  return {
    projectId: project.projectId,
    kind: project.kind,
    brainProjectId: project.brainProjectId,
    brainStatus: brain?.status ?? null,
    goal: brain?.goal ?? null,
    // The registry's displayName is a copy that only refreshes on session
    // start (ensureBrain) — the live brain name wins unless the user renamed.
    displayName: project.customName ?? brain?.name ?? project.displayName,
    customName: project.customName,
    fullPath: project.path,
    path: project.path,
    folderKind: folderKind(project),
    isStarred: project.starred,
    hidden: project.hidden,
    createdAt: project.createdAt,
    sessions,
    sessionMeta: { total: sessions.length, hasMore: false },
  }
}

/** A brain project the registry hasn't touched yet: listed, not persisted. */
function virtualBrainEntry(brain: BrainProject): ProjectEntry {
  return {
    projectId: projectIdForBrain(brain.id),
    kind: 'brain',
    brainProjectId: brain.id,
    path: null,
    displayName: brain.name,
    customName: null,
    starred: false,
    hidden: false,
    createdAt: '',
  }
}

/**
 * The merged project list (decision cockpit-brain-project-model): every brain
 * project (with its local state, if any) + folder-only projects. When the
 * brain can't be read, the registry alone is served so the sidebar degrades
 * instead of emptying.
 */
async function listProjects(deps: HostDeps, space: BrainSpace) {
  let brain: BrainProject[] = []
  try { brain = await space.projects.list() } catch (err) {
    process.stderr.write(`[projects] brain list unavailable: ${(err as Error).message}\n`)
  }
  const byBrainId = new Map(brain.map((p) => [p.id, p]))
  const views = []
  const seen = new Set<string>()
  for (const bp of brain) {
    const entry = space.registry.get(projectIdForBrain(bp.id)) ?? virtualBrainEntry(bp)
    seen.add(entry.projectId)
    views.push(projectView(deps, space, entry, bp))
  }
  for (const entry of space.registry.list()) {
    if (seen.has(entry.projectId)) continue
    // Brain entries whose project is gone from the brain stay listed only if
    // they hold a folder (sessions may live there); folder projects always.
    if (entry.kind === 'brain' && !entry.path) continue
    views.push(projectView(deps, space, entry, entry.brainProjectId ? byBrainId.get(entry.brainProjectId) ?? null : null))
  }
  return views
}

/** Resolve a project id for PATCH: brain projects get their local entry on first touch. */
async function resolveEntry(space: BrainSpace, projectId: string): Promise<{ entry: ProjectEntry | undefined; brain: BrainProject | null }> {
  const existing = space.registry.get(projectId)
  const brainId = brainIdFromProjectId(projectId)
  if (!brainId) return { entry: existing, brain: null }
  let brain: BrainProject | null = null
  try { brain = (await space.projects.list()).find((p) => p.id === brainId) ?? null } catch { /* registry only */ }
  if (existing) return { entry: existing, brain }
  if (!brain) return { entry: undefined, brain: null }
  return { entry: space.registry.ensureBrain(brain.id, brain.name), brain }
}

const SPACE_NAME_MAX = 40

type SpaceError = { error: { code: string; message: string } }

/** A space name as the UI may set it: present, short, unique among the spaces (except `self`). */
function validSpaceName(deps: HostDeps, name: string, self?: BrainSpace): { name: string } | SpaceError {
  const trimmed = name.trim()
  if (!trimmed) return { error: { code: 'NAME_REQUIRED', message: 'A space needs a name.' } }
  if (trimmed.length > SPACE_NAME_MAX) return { error: { code: 'NAME_TOO_LONG', message: `At most ${SPACE_NAME_MAX} characters.` } }
  if (deps.spaces.list().some((s) => s !== self && s.name.toLowerCase() === trimmed.toLowerCase())) {
    return { error: { code: 'NAME_TAKEN', message: 'A space with this name exists.' } }
  }
  return { name: trimmed }
}

/** Settings › Brain › New space: a further local brain with the main brain's identity. */
async function createSpace(deps: HostDeps, name: string): Promise<{ space: BrainSpace } | SpaceError> {
  const valid = validSpaceName(deps, name)
  if ('error' in valid) return valid
  const trimmed = valid.name
  // The identity the main brain was set up with: its agent (= the brain's
  // control-plane name) and the user behind this cockpit's token.
  const main = deps.spaces.main
  const info = readBrainInfo(main.token)
  const agentId = main.brainName
  const userId = info.author ?? info.users[0]?.id
  if (!userId) return { error: { code: 'NO_IDENTITY', message: 'The main brain has no user to copy.' } }
  const { brainId, token } = await provisionSpace(trimmed, {
    agentId,
    agentName: info.agents.find((a) => a.id === agentId)?.name ?? agentId,
    userId,
    userName: info.users.find((u) => u.id === userId)?.name ?? userId,
  })
  const space = openBrainSpace({
    id: brainId, name: trimmed, brainName: agentId, main: false, url: main.url, token, turnHookConfig: deps.turnHookConfig,
  })
  deps.spaces.add(space)
  return { space }
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, deps: HostDeps): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const method = req.method ?? 'GET'
  const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]
  if (parts[0] !== 'api') return false
  const [, resource, id] = parts
  if (await handleSpawnApi(req, res, { spawns: deps.spawns, spawnToken: deps.spawnToken, spaces: deps.spaces, ledger: deps.bridge.ledger, providers: deps.providers }, url.pathname, method, json, readJson)) return true

  // v0.19: the model a cockpit session runs on, for the EML MCP server's
  // provenance stamp (it calls this per write, /model can switch mid-session).
  // Same token as spawning: only sessions of this cockpit carry it.
  if (resource === 'session-model' && id && method === 'GET') {
    if (req.headers['x-cockpit-token'] !== deps.spawnToken) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Only a cockpit session can ask for its model' } })
      return true
    }
    const entry = deps.bridge.ledger.get(id)
    if (!entry) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Session not found' } }); return true }
    const project = entry.projectId ? deps.spaces.resolve(entry.spaceId).registry.get(entry.projectId) : undefined
    const summary = deps.providers.forSession(id).summary(deps.bridge.ledger.ref(id, project?.path ?? null))
    json(res, 200, { model: summary.model, provider: entry.provider })
    return true
  }

  // Spaces: the list, and a new local one (Settings › Brain).
  if (resource === 'spaces' && !id && method === 'GET') {
    json(res, 200, { spaces: deps.spaces.list().map(spaceView) })
    return true
  }
  if (resource === 'spaces' && !id && method === 'POST') {
    const body = await readJson(req)
    try {
      const result = await createSpace(deps, typeof body.name === 'string' ? body.name : '')
      if ('error' in result) json(res, 400, { error: result.error })
      else json(res, 201, { space: spaceView(result.space) })
    } catch (err) {
      json(res, 500, { error: { code: 'SPACE_CREATE_FAILED', message: (err as Error).message } })
    }
    return true
  }

  if (resource === 'spaces' && id && method === 'PATCH') {
    const target = deps.spaces.get(id)
    if (!target) { json(res, 404, { error: { code: 'NO_SUCH_SPACE', message: 'No such brain space' } }); return true }
    const body = await readJson(req)
    const valid = validSpaceName(deps, typeof body.name === 'string' ? body.name : '', target)
    if ('error' in valid) { json(res, 400, valid); return true }
    try {
      await deps.spaces.rename(target, valid.name)
      json(res, 200, { space: spaceView(target) })
    } catch (err) {
      json(res, 500, { error: { code: 'SPACE_RENAME_FAILED', message: (err as Error).message } })
    }
    return true
  }

  // Every other route works in one space.
  const space = deps.spaces.fromHeader(req.headers['x-cockpit-space'])
  if (!space) { json(res, 404, { error: { code: 'NO_SUCH_SPACE', message: 'No such brain space' } }); return true }

  try {
    if (await handleNotesApi(req, res, { loopbackUrl: space.url, brainToken: space.token }, url, method, json, readJson, space.notes)) return true

    // The first-run setup server answers { needed: true } (setup.ts). Here:
    // signIn = right after the setup, before Claude is signed in — the page
    // then shows its sign-in card (onboarding.ts).
    if (resource === 'setup' && !id && method === 'GET') {
      const pending = (await readCockpitConfig())?.onboarding === 'pending'
      json(res, 200, { needed: false, signIn: pending && !(await deps.providers.get('claude')?.auth.signedIn().catch(() => false)) })
      return true
    }

    // Brain hygiene of this space: GET = the banner's offer (null = none),
    // POST start = findings.json + a session. The banner stays until started.
    if (resource === 'brain-hygiene') {
      if (!id && method === 'GET') {
        json(res, 200, { offer: await deps.hygiene.view(space) })
        return true
      }
      if (id === 'start' && method === 'POST') {
        json(res, 200, await deps.hygiene.start(space))
        return true
      }
    }

    if (resource === 'about' && !id && method === 'GET') {
      json(res, 200, { ...ABOUT, claudeVersion: claudeVersion() })
      return true
    }

    // Settings › Brain: the local brain (file, id, schema, identity) and its
    // backups. Paths are display-only; the token never leaves the host.
    if (resource === 'brain-info' && !id && method === 'GET') {
      json(res, 200, readBrainInfo(space.token))
      return true
    }
    if (resource === 'brain-info' && id === 'reveal' && method === 'POST') {
      const file = readBrainInfo(space.token).brainFile
      if (!file) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'No local brain file' } }); return true }
      await revealBrainFile(file)
      json(res, 200, { success: true })
      return true
    }
    if (resource === 'brain-backups' && !id && method === 'GET') {
      // This space's backups only: manual and pre-migration copies both start with the brain id.
      json(res, 200, { backups: listBackups(space.id) })
      return true
    }
    if (resource === 'brain-backups' && !id && method === 'POST') {
      json(res, 200, { backup: await createBackup(space.token) })
      return true
    }

    // Terminal image paste: store the clipboard image, hand back its path.
    if (resource === 'paste-image' && !id && method === 'POST') {
      try {
        json(res, 200, { path: await savePastedImage(req) })
      } catch (error) {
        if (!(error instanceof PasteImageError)) throw error
        json(res, error.status, { error: { code: 'BAD_IMAGE', message: error.message } })
      }
      return true
    }

    // Update banner (v0.14 Cluster 0): the newest brain-migration report and
    // the in-app update this host runs. Dismissing a failure is refused until
    // the brain has caught up.
    if (resource === 'update-status' && !id && method === 'GET') {
      json(res, 200, readUpdateStatus((brainId) => deps.spaces.get(brainId)?.name))
      return true
    }
    if (resource === 'update-status' && id === 'ack' && method === 'POST') {
      const result = acknowledgeUpdateStatus()
      if (result.ok) json(res, 200, { success: true })
      else json(res, 409, { error: { code: 'NOT_RESOLVED', message: result.reason } })
      return true
    }
    if (resource === 'update-status' && id === 'reveal-backup' && method === 'POST') {
      const backup = readUpdateStatus().report?.backupPath
      if (!backup || !fs.existsSync(backup)) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'No backup for this report' } }); return true }
      await revealBrainFile(backup)
      json(res, 200, { success: true })
      return true
    }

    // App updates (Settings › About › Updates, the update banner): status, a
    // check against GitHub Releases, install + restart, go back, and the GitHub
    // token — write-only from the browser (GET reports only its source).
    if (resource === 'app-update') {
      if (!id && method === 'GET') { json(res, 200, readAppUpdateStatus()); return true }
      if (id === 'check' && method === 'POST') { json(res, 200, await checkForUpdate()); return true }
      if ((id === 'apply' || id === 'rollback') && method === 'POST') {
        try {
          const body = id === 'apply' ? ((await readJson(req)) as { version?: unknown }) : {}
          json(res, 200, id === 'apply' ? await applyUpdate(body?.version) : await rollbackUpdate())
        } catch (err) {
          json(res, 409, { error: { code: 'UPDATE_FAILED', message: (err as Error).message } })
        }
        return true
      }
      if (id === 'token' && (method === 'PUT' || method === 'DELETE')) {
        const body = method === 'PUT' ? ((await readJson(req)) as { token?: unknown }) : { token: null }
        const error = writeGithubToken(body?.token ?? null)
        if (error) { json(res, 400, { error: { code: 'INVALID_INPUT', message: error } }); return true }
        json(res, 200, method === 'PUT' ? await checkForUpdate() : readAppUpdateStatus())
        return true
      }
    }

    // Claude sign-in (Settings › Models): mode (Claude Code login | setup-token),
    // the account Claude Code reports, the optional token. The token is
    // write-only from the browser: GET returns set/prefix, never the value.
    // Settings › Models › Sign in: a session that starts with /login, in the
    // active pane's project or the Getting started project (onboarding.ts).
    if (resource === 'agents' && id === 'login' && parts[3] === 'session' && method === 'POST') {
      const body = await readJson(req)
      const requested = typeof body.projectId === 'string' ? body.projectId : null
      const known = requested && (space.registry.get(requested) || brainIdFromProjectId(requested)) ? requested : null
      json(res, 202, { id: queueSignInSession(space.registry, deps.spawns, known) })
      return true
    }

    // Settings › Models: the agent CLIs sessions can run with — which one new
    // sessions start with, each one's cockpit-owned runtime (version, background
    // updates, check now, roll back) and its own settings.
    if (resource === 'providers') {
      const provider = id ? deps.providers.get(id) : undefined
      if (id && !provider) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown provider' } }); return true }
      const [, , , section, action] = parts
      let handled = false
      if (!id && method === 'GET') {
        // Settings › Models asks for a fresh look at the sign-ins (?refresh=1); the menus take the cached answer.
        if (url.searchParams.get('refresh') === '1') for (const p of deps.providers.all()) p.auth.invalidate()
        handled = true
      }
      if (!id && method === 'PATCH') {
        const body = (await readJson(req)) as { default?: unknown }
        if (!isProviderId(body.default) || !deps.providers.get(body.default)) {
          json(res, 400, { error: { code: 'INVALID_INPUT', message: 'default must be a known provider id' } })
          return true
        }
        writeDefaultProvider(body.default)
        handled = true
      }
      if (provider && section === 'runtime' && !action && method === 'PATCH') {
        const body = (await readJson(req)) as { autoUpdate?: unknown }
        if (typeof body?.autoUpdate !== 'boolean') {
          json(res, 400, { error: { code: 'INVALID_INPUT', message: 'autoUpdate must be true or false' } })
          return true
        }
        provider.runtime.setAutoUpdate(body.autoUpdate)
        handled = true
      }
      if (provider && section === 'runtime' && action === 'check' && method === 'POST') {
        await provider.runtime.check()
        handled = true
      }
      if (provider && section === 'runtime' && action === 'rollback' && method === 'POST') {
        try {
          await provider.runtime.rollback()
        } catch (e) {
          json(res, 409, { error: { code: 'NO_PREVIOUS', message: (e as Error).message } })
          return true
        }
        handled = true
      }
      if (provider && section === 'settings' && !action && method === 'PATCH') {
        const error = provider.settings
          ? provider.settings.write(await readJson(req))
          : `${provider.label} has no settings here`
        if (error) { json(res, 400, { error: { code: 'INVALID_INPUT', message: error } }); return true }
        handled = true
      }
      if (handled) {
        json(res, 200, { providers: await providerViews(deps) })
        return true
      }
    }

    if (resource === 'agents' && id === 'login' && !parts[3]) {
      if (method === 'GET') {
        if (url.searchParams.has('refresh')) invalidateAccountCache()
        json(res, 200, await claudeLoginStatus())
        return true
      }
      if (method === 'PUT' || method === 'PATCH') {
        const body = (await readJson(req)) as { token?: unknown; mode?: unknown; permissionMode?: unknown; renderer?: unknown }
        const error = method === 'PUT' ? writeClaudeLogin(body?.token) : writeAgentPatch(body)
        if (error) { json(res, 400, { error: { code: 'INVALID_INPUT', message: error } }); return true }
        invalidateAccountCache()
        json(res, 200, await claudeLoginStatus())
        return true
      }
      if (method === 'DELETE') {
        clearClaudeLogin()
        invalidateAccountCache()
        json(res, 200, await claudeLoginStatus())
        return true
      }
    }

    // Session hook → turn state (see turn-state.ts). turn-hook.ts from the agent CLI,
    // no Origin; the per-boot token in the hook header is the guard.
    if (resource === 'hook' && !id && method === 'POST') {
      if (req.headers[HOOK_TOKEN_HEADER] !== deps.hookToken) {
        json(res, 403, { error: { code: 'FORBIDDEN', message: 'Bad hook token' } })
        return true
      }
      // The hook names the cockpit session it runs in; the payload carries the
      // provider's own id, which the ledger keeps for resume and transcripts.
      const named = req.headers[HOOK_SESSION_HEADER]
      applySessionHook(
        { providers: deps.providers, ledger: deps.bridge.ledger, turns: deps.turns },
        typeof named === 'string' && named ? named : null,
        await readJson(req),
      )
      json(res, 200, { ok: true })
      return true
    }

    // Server-sent turn events for the UI: a full snapshot on (re)connect,
    // then one `turn` event per change; keep-alive comment every 25s.
    if (resource === 'events' && !id && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      res.write('retry: 2000\n\n')
      send('snapshot', deps.turns.snapshot())
      const onTurn = (event: TurnEvent) => send('turn', event)
      deps.turns.on('turn', onTurn)
      const detachSpawns = attachSpawnEvents(deps.spawns, send)
      // Note changes of every space, each tagged with its space (null = main,
      // as the pane store keys it) — including spaces added while connected.
      const detachNotes: Array<() => void> = []
      const followNotes = (s: BrainSpace) => {
        detachNotes.push(s.notes.subscribe((change: NotesChange) => send('notes', { ...change, spaceId: s.ledgerKey })))
      }
      for (const s of deps.spaces.list()) followNotes(s)
      detachNotes.push(deps.spaces.onAdd(followNotes))
      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(keepAlive)
        deps.turns.off('turn', onTurn)
        detachSpawns()
        for (const detach of detachNotes) detach()
      })
      return true
    }

    // Projects
    if (resource === 'projects' && !id && method === 'GET') {
      json(res, 200, { projects: await listProjects(deps, space) })
      return true
    }
    if (resource === 'projects' && !id && method === 'POST') {
      const body = await readJson(req)
      const { project, created } = space.registry.create(
        typeof body.path === 'string' ? body.path : '',
        typeof body.customName === 'string' ? body.customName : null,
      )
      if (project.path) trustProject(deps, project.path)
      json(res, created ? 201 : 200, { success: true, created, project: projectView(deps, space, project) })
      return true
    }
    if (resource === 'projects' && id && method === 'PATCH') {
      const body = await readJson(req)
      const { entry, brain } = await resolveEntry(space, id)
      if (!entry) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Project not found' } }); return true }
      // A session started without a folder gets its cockpit folder at spawn
      // (pty-bridge), not through this route.
      const requestedPath: string | null | undefined =
        typeof body.path === 'string' ? body.path : body.path === null ? null : undefined
      // Renaming a brain project renames it in the brain, not in the local
      // registry: a local name would drift from the one agents see. The local
      // name stays for folder projects, and for a brain entry whose project is
      // gone from the brain (404).
      let displayName: string | null | undefined = typeof body.displayName === 'string' ? body.displayName : undefined
      let renamedBrain: BrainProject | null = brain
      let brainName: string | null = null
      if (displayName !== undefined && entry.kind === 'brain' && entry.brainProjectId) {
        const name = (displayName ?? '').trim()
        if (!name) {
          json(res, 400, { error: { code: 'NAME_REQUIRED', message: 'A brain project needs a name.' } })
          return true
        }
        try {
          await space.projects.rename(entry.brainProjectId, name)
          renamedBrain = brain ? { ...brain, name } : null
          brainName = name
          displayName = null
        } catch (err) {
          if (!(err instanceof BrainRenameError) || err.status !== 404) {
            json(res, 502, { error: { code: 'BRAIN_UNAVAILABLE', message: 'The brain did not take the new name — nothing was changed.' } })
            return true
          }
        }
      }
      let project = space.registry.update(id, {
        displayName,
        starred: typeof body.isStarred === 'boolean' ? body.isStarred : undefined,
        hidden: typeof body.hidden === 'boolean' ? body.hidden : undefined,
        path: requestedPath,
        brainName: renamedBrain?.name,
      })
      // The registry keeps a copy of the brain name for when the brain is unreachable.
      if (brainName !== null && entry.brainProjectId) project = space.registry.ensureBrain(entry.brainProjectId, brainName)
      if (typeof requestedPath === 'string' && project.path) trustProject(deps, project.path)
      json(res, 200, { success: true, project: projectView(deps, space, project, renamedBrain) })
      return true
    }
    if (resource === 'projects' && id && method === 'DELETE') {
      const project = space.registry.get(id)
      if (!project) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Project not found' } }); return true }
      const deleteData = url.searchParams.get('deleteData') === '1'
      deps.bridge.killProjectSessions(id, space.ledgerKey)
      for (const entry of deps.bridge.ledger.list(id, space.ledgerKey)) {
        if (deleteData) deps.providers.forSession(entry.sessionId).deleteTranscript(deps.bridge.ledger.ref(entry.sessionId, project.path))
        deps.bridge.ledger.remove(entry.sessionId)
      }
      space.registry.remove(id)
      json(res, 200, { success: true })
      return true
    }

    // Sessions
    if (resource === 'sessions' && !id && method === 'GET') {
      const projectId = url.searchParams.get('projectId') ?? undefined
      const sessions = deps.bridge.ledger.list(projectId, space.ledgerKey)
        .map((entry) => sessionView(deps, entry.projectId ? space.registry.get(entry.projectId) : undefined, entry))
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
      json(res, 200, { sessions })
      return true
    }
    if (resource === 'sessions' && id && method === 'PATCH') {
      const body = await readJson(req)
      const entry = deps.bridge.ledger.update(id, {
        title: typeof body.title === 'string' ? body.title : undefined,
        pinned: typeof body.isPinned === 'boolean' ? body.isPinned : undefined,
      })
      if (!entry) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Session not found' } }); return true }
      const project = entry.projectId ? space.registry.get(entry.projectId) : undefined
      json(res, 200, { success: true, session: sessionView(deps, project, { sessionId: id, ...entry }) })
      return true
    }
    if (resource === 'sessions' && id && method === 'DELETE') {
      const entry = deps.bridge.ledger.get(id)
      if (!entry) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Session not found' } }); return true }
      deps.bridge.killSession(id)
      deps.turns.forget(id)
      const project = entry.projectId ? space.registry.get(entry.projectId) : undefined
      deps.providers.forSession(id).deleteTranscript(deps.bridge.ledger.ref(id, project?.path ?? null))
      deps.bridge.ledger.remove(id)
      json(res, 200, { success: true })
      return true
    }

    // Folder listing + creation for the add-project and set-folder dialogs (directories only)
    if (resource === 'folders' && !id && method === 'GET') {
      json(res, 200, browseFolders(url.searchParams.get('path') ?? '~'))
      return true
    }
    if (resource === 'folders' && !id && method === 'POST') {
      const body = await readJson(req)
      const created = createFolder(typeof body.path === 'string' ? body.path : '')
      json(res, 200, { success: true, path: created })
      return true
    }

    // PTY attach handshake
    if (resource === 'pty' && method === 'POST') {
      json(res, 200, deps.bridge.mintNonce())
      return true
    }
  } catch (err) {
    fail(res, err)
    return true
  }
  return false
}

async function proxyBrain(req: http.IncomingMessage, res: http.ServerResponse, deps: HostDeps) {
  const space = deps.spaces.fromHeader(req.headers['x-cockpit-space'])
  if (!space) { json(res, 404, { error: { code: 'NO_SUCH_SPACE', message: 'No such brain space' } }); return }
  const rel = (req.url ?? '').slice('/api/brain'.length) || '/'
  const method = req.method ?? 'GET'
  const headers: Record<string, string> = {
    Authorization: `Bearer ${space.token}`,
    Accept: 'application/json',
  }
  let body: Buffer | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readBody(req)
    if (body.length) headers['Content-Type'] = req.headers['content-type'] ?? 'application/json'
  }
  try {
    const upstream = await fetch(`${space.url}${rel}`, {
      method, headers, body: body ? new Uint8Array(body) : undefined,
    })
    const text = await upstream.text()
    // A project created/patched through the proxy must show up in the next
    // GET /api/projects, not after the 5s cache lapses (a new project used to
    // appear only after a reload). v0.19: the wizard creates and the detail
    // updates through /object/project (POST, PUT /object/project/:id) — those
    // invalidate too.
    if (upstream.ok && method !== 'GET' && method !== 'HEAD' && /^\/(object\/)?projects?(\/|\?|$)/.test(rel)) {
      space.projects.invalidate()
    }
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    })
    res.end(text)
  } catch {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Failed to reach the brain API.' }))
  }
}

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const urlPath = (req.url ?? '/').split('?')[0]
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const filePath = path.join(FRONTEND_DIST, rel)
  // Prevent path traversal outside dist.
  if (!filePath.startsWith(FRONTEND_DIST)) { res.writeHead(403); res.end(); return }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' })
    fs.createReadStream(filePath).pipe(res)
    return
  }
  // SPA fallback → index.html
  const indexPath = path.join(FRONTEND_DIST, 'index.html')
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, { 'Content-Type': MIME['.html'] })
    fs.createReadStream(indexPath).pipe(res)
    return
  }
  // No frontend built yet (host-only milestones): placeholder.
  res.writeHead(200, { 'Content-Type': MIME['.html'] })
  res.end('<!doctype html><meta charset=utf-8><title>EML Cockpit</title>' +
    '<body style="font-family:monospace;padding:2rem"><h1>EML Cockpit host</h1>' +
    '<p>Host is up. Frontend not built yet — run the frontend build.</p>')
}

export function createHostServer(deps: HostDeps, allowedOrigins: string[]): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/health') {
      json(res, 200, { status: 'ok' })
      return
    }
    // CSRF guard for the whole API surface, including the brain proxy (the host
    // injects the brain token, so a cross-origin write would otherwise reach the
    // real brain): every state-changing /api/* call must carry an allowlisted
    // Origin — the cockpit's own page. The two token-authenticated machine
    // endpoints carry no Origin and are exempt: /api/hook (session hooks, per-boot
    // token in the x-cockpit-hook header) and /api/spawn (worker spawn, X-Cockpit-Token). Reads
    // (GET/HEAD) are open; a cross-origin page still can't read the response.
    if (url.startsWith('/api/')) {
      const method = req.method ?? 'GET'
      const write = method !== 'GET' && method !== 'HEAD'
      const tokenEndpoint = /^\/api\/(hook|spawn)(\?|$)/.test(url)
      if (write && !tokenEndpoint && !allowedOrigins.includes(req.headers.origin ?? '')) {
        json(res, 403, { error: { code: 'FORBIDDEN', message: 'Cross-origin request refused' } })
        return
      }
    }
    // Only /api/brain and /api/brain/… — not host routes like /api/brain-info.
    if (/^\/api\/brain(\/|\?|$)/.test(url)) { void proxyBrain(req, res, deps); return }
    if (url.startsWith('/api/')) {
      void handleApi(req, res, deps).then((handled) => {
        if (!handled) json(res, 404, { error: { code: 'NOT_FOUND', message: 'No such endpoint' } })
      })
      return
    }
    serveStatic(req, res)
  })

  // Guarded WS upgrade on /ws/shell?nonce= — the session identity travels in
  // the `init` frame so a pane can reattach to its running PTY.
  // perMessageDeflate off: loopback only, compression is pure CPU waste.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url ?? '', 'http://127.0.0.1')
    if (pathname !== '/ws/shell') { socket.destroy(); return }
    const origin = req.headers.origin
    if (!origin || !allowedOrigins.includes(origin)) { socket.destroy(); return }
    const nonce = searchParams.get('nonce') ?? ''
    if (!deps.bridge.consumeNonce(nonce)) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Disable Nagle on loopback — it only delays small frames.
      const tcp = (ws as unknown as { _socket?: { setNoDelay?: (f: boolean) => void } })._socket
      tcp?.setNoDelay?.(true)
      deps.bridge.attach(ws)
    })
  })

  return server
}
