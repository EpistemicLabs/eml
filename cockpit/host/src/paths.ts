import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * Central path resolution. The host runs from its own package directory: the
 * bundled brain server + core (dist/*.cjs), the built frontend (ui/) and the
 * migrations are produced by scripts/build.mjs and shipped with the package. Only
 * the MCP server is a real dependency (@engramprotocol/mcp-server, published).
 * Runtime state lives under ~/.eml-cockpit/ (EML_COCKPIT_HOME; persistent,
 * self-custody, chmod-locked).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// This package's own root (src/ and dist/ both sit one level below it).
export const HOST_ROOT = path.resolve(__dirname, '..')

export const SERVER_JS = path.join(HOST_ROOT, 'dist', 'server.cjs')     // brain server + core, bundled
export const CORE_INDEX = path.join(HOST_ROOT, 'dist', 'core.cjs')      // core for provisioning, bundled
// Preload for the brain server: exits it when the host is gone (brain-watchdog.ts).
export const BRAIN_WATCHDOG_JS = path.join(HOST_ROOT, 'dist', 'brain-watchdog.js')
// CLI a session runs to open a worker session (spawn-cli.ts, skill spawn-session).
export const SPAWN_CLI_JS = path.join(HOST_ROOT, 'dist', 'spawn-cli.js')
// Skills that only make sense inside the cockpit (spawn-session).
export const COCKPIT_SKILLS_DIR = path.join(HOST_ROOT, 'skills')
const MCP_ROOT = path.dirname(require.resolve('@engramprotocol/mcp-server/package.json'))
export const MCP_CLI_JS = path.join(MCP_ROOT, 'dist', 'cli.js')
// EML skills (consolidate, checkpoint, getting-started, brain-hygiene) shipped with the mcp-server package.
export const MCP_SKILLS_DIR = path.join(MCP_ROOT, 'templates', 'skills')

// Frontend: in the workspace checkout serve the frontend package's own dist/ so a
// plain `vite build` reaches the running host without re-assembling the package;
// in the installed package (frontend is a devDependency, not present) serve the
// copy that scripts/build.mjs put into ui/.
export const FRONTEND_DIST = (() => {
  try {
    return path.join(path.dirname(require.resolve('@engramprotocol/cockpit-frontend/package.json')), 'dist')
  } catch {
    return path.join(HOST_ROOT, 'ui')
  }
})()

// The cockpit home: all app state, one folder per cockpit (dev and real brain
// run side by side with different EML_COCKPIT_HOMEs). Nothing is read from the
// user's own ~/.claude or ~/.eml — the app brings and keeps everything here.
export const COCKPIT_HOME = process.env.EML_COCKPIT_HOME
  ? path.resolve(process.env.EML_COCKPIT_HOME)
  : path.join(os.homedir(), '.eml-cockpit')
export const DATA_DIR = path.join(COCKPIT_HOME, 'data')          // control.db + brains/
export const BACKUPS_DIR = path.join(COCKPIT_HOME, 'backups')    // manual backups; pre-migration/ from the brain server
export const MIGRATION_REPORTS_DIR = path.join(DATA_DIR, 'migration-reports') // one JSON per attempted brain migration
export const CONFIG_DIR = path.join(COCKPIT_HOME, 'claude-config') // isolated CLAUDE_CONFIG_DIR
export const CODEX_CONFIG_DIR = path.join(COCKPIT_HOME, 'codex-config') // isolated CODEX_HOME
// The cockpit's own Codex CLI + its versions (providers/codex/runtime.ts).
export const CODEX_RUNTIME_DIR = path.join(COCKPIT_HOME, 'codex')
// The cockpit's own Claude Code binary + its versions (providers/claude/runtime.ts).
export const CLAUDE_RUNTIME_DIR = path.join(COCKPIT_HOME, 'claude')
// The installed app (app-update.ts): app/versions/<v>/node_modules/eml-cockpit
// is one installed host, app/current the symlink to the one that runs.
export const APP_DIR = path.join(COCKPIT_HOME, 'app')

/**
 * A file of this host addressed through app/current instead of app/versions/<v>,
 * so a path written into a session's config survives an update. Hook texts are
 * the case: an agent CLI stores them (Codex trusts a hook by its exact text), and
 * a version folder is removed two updates later — a hook naming it then fails on
 * every turn. Unchanged when the host does not run from an installed version
 * (a checkout, a dev cockpit).
 */
export function stableAppPath(file: string): string {
  const versions = path.join(APP_DIR, 'versions')
  let realVersions: string
  try { realVersions = fs.realpathSync(versions) } catch { return file }
  let real: string
  try { real = fs.realpathSync(file) } catch { real = file }
  const rel = path.relative(realVersions, real)
  const [version, ...rest] = rel.split(path.sep)
  if (rel.startsWith('..') || path.isAbsolute(rel) || !/^\d+\.\d+\.\d+$/.test(version) || rest.length === 0) return file
  return path.join(APP_DIR, 'current', ...rest)
}

// What the EML hook commands name (shared.ts, emlHookEntry): the mcp-server CLI
// through app/current, and node through a link the host keeps at <home>/bin/node
// (ensureHookNode) — both stay the same text across cockpit and node updates.
export const HOOK_MCP_CLI_JS = stableAppPath(MCP_CLI_JS)
export const HOOK_NODE = path.join(COCKPIT_HOME, 'bin', 'node')
export const CONFIG_FILE = path.join(COCKPIT_HOME, 'config')     // { token } chmod 600 (local loopback token)
// Optional setup-token (Settings › Models › Advanced), injected per session only
// in token mode. chmod 600, never sent back to the browser.
export const CLAUDE_LOGIN_FILE = path.join(COCKPIT_HOME, 'claude-login')
// Agent settings (sign-in mode: Claude Code login by default, or the setup-token).
export const AGENTS_FILE = path.join(COCKPIT_HOME, 'agents.json')
// EML client config the session hooks read (brain URL + token of this boot).
export const EML_HOOK_DIR = path.join(COCKPIT_HOME, 'eml')
// Per brain space (brain-space.ts): the files a space's sessions start with —
// mcp.json + settings.json under claude-config/spaces/<id>/, the EML hook
// config (with its logs/ and state/) under eml/spaces/<id>/.
export const spaceConfigDir = (spaceId: string) => path.join(CONFIG_DIR, 'spaces', spaceId)
export const spaceEmlDir = (spaceId: string) => path.join(EML_HOOK_DIR, 'spaces', spaceId)
// Pre-spaces locations of those files (one brain per home); removed on boot.
export const LEGACY_EML_HOOK_CONFIG = path.join(EML_HOOK_DIR, 'config')
// The curl config (-K) carrying the per-boot hook token for Claude Code's turn-state
// hooks — written by the Claude provider, read into every space's settings.json.
export const CLAUDE_HOOK_CURL_CONFIG = path.join(CONFIG_DIR, 'hook-curl.conf')
// Worker requests as files, for sessions whose sandbox has no network (spawn-inbox.ts).
export const SPAWN_INBOX_DIR = path.join(COCKPIT_HOME, 'spawn-inbox')
// v0.17 task runs: the home of a task's files when its project has no folder of its own.
export const TASKS_DIR = path.join(COCKPIT_HOME, 'tasks')
// Cockpit folders: made for brain projects that have no folder of their own
// ("Start session" without picking one): <COCKPIT_FOLDERS_DIR>/<brain id>.
// The directory keeps its pre-0.17.4 name "workspaces" so existing projects
// keep their paths.
export const COCKPIT_FOLDERS_DIR = path.join(COCKPIT_HOME, 'workspaces')
