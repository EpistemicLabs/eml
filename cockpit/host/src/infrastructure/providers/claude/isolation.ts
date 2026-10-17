import * as fs from 'node:fs'
import * as path from 'node:path'
import { CLAUDE_HOOK_CURL_CONFIG, COCKPIT_SKILLS_DIR, CONFIG_DIR, LEGACY_EML_HOOK_CONFIG, MCP_SKILLS_DIR, spaceConfigDir, spaceEmlDir } from '../../../paths.js'
import { currentVersion } from './runtime.js'
import { claudeThemeMigrated, markClaudeThemeMigrated } from './login.js'
import { HOOK_TOKEN_HEADER } from '../../../domain/agent-provider.js'
import { brainMcpServer, emlHookEntry, ensureHookNode, hookCurlConfig, hookEntry, installManagedSkills, quote, writeEmlHookConfig } from '../shared.js'

/**
 * The app's own Claude environment (decision cockpit-isolation-scope-clarified):
 * everything global to Claude Code — settings, .claude.json, sessions, MCP
 * registration, auth — lives in this CLAUDE_CONFIG_DIR, fully separate from the
 * user's ~/.claude / ~/.claude.json. Sessions themselves run in the user's real
 * projects (cwd = project path), so a project's CLAUDE.md, .claude/settings.json
 * and .claude/settings.local.json load as intended. The brain MCP is injected via
 * --mcp-config; MCPs the user adds inside the cockpit (user scope in this dir's
 * .claude.json, claude.ai connectors, plugins, project .mcp.json) load alongside.
 *
 * Files written here, shared by every brain space (writeIsolationFiles):
 *   - hook-curl.conf (chmod 600): the per-boot hook token as a curl header for
 *     the turn-state hooks, so it stays out of the hook command line.
 *   - skills/<name>/SKILL.md: the EML skills (consolidate, checkpoint, getting-started, brain-hygiene) from the
 *     bundled mcp-server plus the cockpit's own (spawn-session), refreshed each
 *     boot; a skill of the same name without the managed marker is left alone.
 *   - .claude.json: first-run state pre-seeded (onboarding done, theme) so an
 *     INTERACTIVE spawn opens the session instead of the "Choose the text
 *     style" wizard; per-project trust is seeded by ensureProjectTrusted().
 *     Merged over whatever claude already wrote there (machineID, migrations,
 *     …); user-changeable keys (theme) are only seeded when absent. The theme
 *     is seeded as `auto` — Claude Code then matches the pane's background,
 *     so it follows the cockpit's light/dark theme (see seededClaudeTheme).
 *
 * Per brain space, under spaces/<id>/ (writeSpaceFiles, called by brain-space.ts):
 *   - mcp.json (chmod 600): the brain MCP server (eml_brain) pointed at the
 *     space's brain with its token, both passed as env (never argv).
 *   - settings.json (passed via --settings): skips the interactive "Bypass
 *     Permissions mode" acceptance dialog that --dangerously-skip-permissions
 *     otherwise shows on every TUI start; carries the session hooks — turn
 *     state to the host, and the EML hooks (boot, reminder, consolidate at stop) from the bundled
 *     @engramprotocol/mcp-server, reading the space's EML config.
 *   - <home>/eml/spaces/<id>/config (chmod 600): brain URL + token of the space
 *     for those EML hooks — the app's own EML client config, never the user's ~/.eml.
 */

/** The shared isolation files of this boot; a space's own files are SpaceFiles. */
export interface IsolationFiles {
  configDir: string
  /** curl config (-K) carrying the per-boot hook token for the turn-state hooks. */
  curlConfig: string
}

const CLAUDE_JSON = path.join(CONFIG_DIR, '.claude.json')

/** The cockpit's own Claude Code version (runtime.ts) — never the user's install. */
export function claudeVersion(): string {
  return currentVersion() ?? '2.1.0'
}

/** The JSON object in a file, or null when the file is missing, unreadable or not an object. */
function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function readClaudeJson(): Record<string, unknown> {
  return readJsonObject(CLAUDE_JSON) ?? {}
}

function writeClaudeJson(data: Record<string, unknown>): void {
  fs.writeFileSync(CLAUDE_JSON, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.chmodSync(CLAUDE_JSON, 0o600)
}

/**
 * Claude Code's own theme for cockpit sessions. `auto` ("match terminal") asks
 * the terminal for its background when a session starts — the pane answers
 * with the cockpit theme's colour, and COLORFGBG (pty-bridge.ts) says the same.
 *
 * Cockpits before the light theme seeded `dark`, which is unreadable on a
 * light pane, so that value is switched to `auto` once (`migrated` records
 * it). Any other value, and a `dark` chosen after the switch, is the user's
 * own /theme choice and stays.
 */
export function seededClaudeTheme(existing: unknown, migrated: boolean): string {
  if (typeof existing !== 'string' || !existing) return 'auto'
  if (existing === 'dark' && !migrated) return 'auto'
  return existing
}

function seedClaudeJson(): void {
  const existing = readClaudeJson()
  const theme = seededClaudeTheme(existing.theme, claudeThemeMigrated())
  markClaudeThemeMigrated()
  writeClaudeJson({
    ...existing,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: claudeVersion(),
    hasAcknowledgedCostThreshold: true,
    // Claude Code's diff sidebar auto-opens on the first file edit when the
    // pane is wide enough; it narrows the conversation column mid-render and
    // leaves wrapped fragments behind. Panes in the cockpit never want it.
    diffSidebarOpen: false,
    theme,
    projects: existing.projects ?? {},
  })
}

/**
 * Mark a project directory as trusted in the app's .claude.json so the TUI
 * doesn't open with the "Do you trust the files in this folder?" dialog.
 * Idempotent; called when a project is registered and before every spawn.
 */
export function ensureProjectTrusted(projectPath: string): void {
  const existing = readClaudeJson()
  const projects = { ...((existing.projects as Record<string, unknown>) ?? {}) }
  const current = (projects[projectPath] as Record<string, unknown>) ?? {}
  if (current.hasTrustDialogAccepted === true) return
  projects[projectPath] = { ...current, hasTrustDialogAccepted: true }
  writeClaudeJson({ ...existing, projects })
}

export { HOOK_TOKEN_HEADER, brainMcpServer, hookCurlConfig, hookEntry }

/** The files a brain space's sessions start with (brain-space.ts). */
export interface SpaceFiles {
  /** --mcp-config: the brain MCP server with this space's URL + token. */
  mcpConfig: string
  /** --settings: the session hooks, with the EML hooks reading `emlConfig`. */
  settings: string
  /** EML client config of this space for those hooks (URL + token). */
  emlConfig: string
}

/**
 * Write one space's mcp.json, settings.json and EML hook config. Called once
 * per space on every boot, after writeIsolationFiles (the shared files).
 */
export function writeSpaceFiles(
  spaceId: string,
  loopbackUrl: string,
  brainToken: string,
  hookUrl: string,
  curlConfig: string,
): SpaceFiles {
  const dir = spaceConfigDir(spaceId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  const mcpConfig = path.join(dir, 'mcp.json')
  const settings = path.join(dir, 'settings.json')
  const emlConfig = path.join(spaceEmlDir(spaceId), 'config')

  writeEmlHookConfig(emlConfig, loopbackUrl, brainToken)
  fs.writeFileSync(
    mcpConfig,
    JSON.stringify({ mcpServers: { eml_brain: brainMcpServer(loopbackUrl, brainToken) } }),
    { mode: 0o600 },
  )
  fs.chmodSync(mcpConfig, 0o600)
  fs.writeFileSync(
    settings,
    JSON.stringify({
      skipDangerousModePermissionPrompt: true,
      hooks: {
        SessionStart: [emlHookEntry('session-start', quote(emlConfig))],
        UserPromptSubmit: [hookEntry(hookUrl, curlConfig), emlHookEntry('user-prompt-submit', quote(emlConfig))],
        // The EML stop hook may block the stop once to consolidate (mcp-server hooks/compaction.ts).
        Stop: [hookEntry(hookUrl, curlConfig), emlHookEntry('stop', quote(emlConfig))],
        // Every notification type reaches the host; turn-state.ts decides which
        // mean "waiting" and logs the others, so a new type shows up in host.log.
        Notification: [hookEntry(hookUrl, curlConfig)],
      },
    }, null, 2),
    { mode: 0o600 },
  )
  fs.chmodSync(settings, 0o600)
  return { mcpConfig, settings, emlConfig }
}

/**
 * Write the files every space shares: the curl config with the hook token,
 * the skills, the seeded .claude.json. The per-space files (mcp.json,
 * settings.json, EML hook config) follow in writeSpaceFiles.
 */
export function writeIsolationFiles(hookToken: string): IsolationFiles {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  ensureHookNode()
  installManagedSkills([MCP_SKILLS_DIR, COCKPIT_SKILLS_DIR], CONFIG_DIR)

  const curlConfig = CLAUDE_HOOK_CURL_CONFIG
  fs.writeFileSync(curlConfig, hookCurlConfig(hookToken), { mode: 0o600 })
  fs.chmodSync(curlConfig, 0o600)
  seedClaudeJson()

  // Before spaces, mcp.json and eml/config sat here carrying the brain token
  // — stale copies of a secret, so they go.
  for (const legacy of [path.join(CONFIG_DIR, 'mcp.json'), LEGACY_EML_HOOK_CONFIG]) {
    fs.rmSync(legacy, { force: true })
  }
  removeLegacyHostHooks(path.join(CONFIG_DIR, 'settings.json'))

  return { configDir: CONFIG_DIR, curlConfig }
}

/**
 * settings.json in CONFIG_DIR is Claude Code's own user-settings file. Before
 * spaces (≤ 0.17.3) the host wrote its session hooks into it: the EML hooks
 * reading the removed eml/config, and the turn-state curl hooks posting to the
 * host's /api/hook (with the token in the URL up to 0.17.1, via hook-curl.conf
 * from 0.17.2). Claude Code still loads the file next to the space's
 * --settings, so those hooks ran on in every session — the curl ones doubled
 * the turn-state posts, the EML ones named the cli.js of the version installed
 * back then, which an update removes, so every prompt showed a MODULE_NOT_FOUND
 * hook error. The host's commands are recognised by what every version wrote
 * (the legacy config path, the loopback /api/hook URL) and removed one by one;
 * what Claude Code wrote itself since (model, permissions, its own hooks, also
 * inside the same matcher group) stays. A file left with nothing but the
 * host's skipDangerousModePermissionPrompt goes.
 */
function removeLegacyHostHooks(settingsFile: string): void {
  const settings = readJsonObject(settingsFile)
  if (!settings) return
  const events = settings.hooks
  if (!events || typeof events !== 'object' || Array.isArray(events)) return

  const legacyEmlConfig = `--config ${quote(LEGACY_EML_HOOK_CONFIG)}`
  const hostHookUrl = /--data-binary @- 'http:\/\/127\.0\.0\.1:\d+\/api\/hook['?]/
  const isHostCommand = (h: unknown) => {
    const command = (h as { command?: unknown } | null)?.command
    return typeof command === 'string' && (command.includes(legacyEmlConfig) || hostHookUrl.test(command))
  }

  let changed = false
  for (const [event, entries] of Object.entries(events as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    const kept: unknown[] = []
    for (const entry of entries) {
      const commands = (entry as { hooks?: unknown } | null)?.hooks
      if (!Array.isArray(commands)) { kept.push(entry); continue }
      const own = commands.filter((h) => !isHostCommand(h))
      if (own.length === commands.length) { kept.push(entry); continue }
      changed = true
      if (own.length > 0) kept.push({ ...(entry as object), hooks: own })
    }
    if (kept.length > 0) (events as Record<string, unknown>)[event] = kept
    else delete (events as Record<string, unknown>)[event]
  }
  if (!changed) return
  if (Object.keys(events).length === 0) delete settings.hooks

  const own = Object.keys(settings).filter((k) => k !== 'skipDangerousModePermissionPrompt')
  if (own.length === 0) {
    fs.rmSync(settingsFile, { force: true })
    return
  }
  // Claude Code reads this file on every session start: replace it atomically, keeping its
  // mode. If that fails, the stale hooks stay for another boot — better than a host that does not start.
  const tmp = `${settingsFile}.${process.pid}.tmp`
  try {
    const mode = fs.statSync(settingsFile).mode & 0o777
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode })
    fs.renameSync(tmp, settingsFile)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    process.stderr.write(`[isolation] could not rewrite ${settingsFile}: ${(err as Error).message}\n`)
  }
}
