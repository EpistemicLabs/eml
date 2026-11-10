import * as fs from 'node:fs'
import * as path from 'node:path'
import { HOOK_LIST_AGENTS_JS, HOOK_MCP_CLI_JS, HOOK_NODE, HOOK_SEND_MESSAGE_JS, HOOK_TURN_JS } from '../../paths.js'
import type { PlatformOs } from '../../domain/platform.js'
import { platform } from '../platform/index.js'

/**
 * What every provider's isolated config is built from: the brain MCP server,
 * the turn-state hook, and the EML hooks (boot + reminder) with their config,
 * each hook as a HookCommand rendered per provider and OS.
 */

/**
 * A hook as data: the program and its arguments, no shell syntax. Everything
 * a hook needs at run time (token, URL, the session's ids and files) it reads
 * from a file or the session's env, so one command works in every shell an
 * agent CLI may run it in. The providers render it (claudeHook, codexHook).
 */
export interface HookCommand {
  program: string
  args: string[]
}

/** Quote for a POSIX shell command line. */
export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Quote for PowerShell: a single-quoted string is literal, '' is a quote. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

/** The command as a POSIX shell line; a word with nothing the shell reads stays bare. */
export const shellLine = (cmd: HookCommand) => [cmd.program, ...cmd.args].map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : quote(w))).join(' ')

/** The command as a PowerShell line: a quoted program needs the call operator. */
export const powershellLine = (cmd: HookCommand) => `& ${[cmd.program, ...cmd.args].map(psQuote).join(' ')}`

/**
 * A Claude Code hook. On Windows in exec form (command + args): Claude Code
 * spawns it without a shell, so it runs with or without Git Bash. Elsewhere a
 * shell line, which every Claude Code version reads.
 */
export function claudeHook(cmd: HookCommand, os: PlatformOs, extra: Record<string, unknown> = {}) {
  const command = os === 'win32' ? { command: cmd.program, args: cmd.args } : { command: shellLine(cmd) }
  return { type: 'command', ...command, ...extra }
}

/** A Codex hook: Codex has no exec form and runs hooks through PowerShell on Windows, sh elsewhere. */
export function codexHook(cmd: HookCommand, os: PlatformOs, extra: Record<string, unknown> = {}) {
  return { type: 'command', command: os === 'win32' ? powershellLine(cmd) : shellLine(cmd), ...extra }
}

/**
 * The turn-state hook's config: where to POST and the per-boot token, in an
 * owner-only file, so the token never appears in the hook command line —
 * command lines are visible to every local user via ps. Rewritten on every
 * boot; the command naming it stays the same (Codex asks the user to trust a
 * hook again whenever its text changes).
 */
export function writeTurnHookConfig(file: string, hookUrl: string, hookToken: string): void {
  fs.writeFileSync(file, JSON.stringify({ url: hookUrl, token: hookToken }) + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

/**
 * The hook that reports turn state to the host (turn-state.ts, turn-hook.ts):
 * it streams the hook's stdin JSON to POST /api/hook, never fails the CLI's
 * turn, and is run async by the providers so the CLI never waits on it.
 */
export function turnHookCommand(configFile: string): HookCommand {
  return { program: hookNode(), args: [HOOK_TURN_JS, configFile] }
}

/** The turn hook's own options, the same for Claude Code and Codex. */
export const TURN_HOOK_OPTIONS = { timeout: 5, async: true }

/** The hook that wakes a stopped session for SendMessage (send-message-hook.ts); URL and token come from the session's env. */
export function sendMessageHookCommand(): HookCommand {
  return { program: hookNode(), args: [HOOK_SEND_MESSAGE_JS] }
}

/** Longer than the hook's own wait for the host: a stopped session has to start first. */
export const SEND_MESSAGE_HOOK_OPTIONS = { timeout: 40 }

export function listAgentsHookCommand(): HookCommand {
  return { program: hookNode(), args: [HOOK_LIST_AGENTS_JS] }
}

/** Longer than the hook's own wait for the host. */
export const LIST_AGENTS_HOOK_OPTIONS = { timeout: 10 }

/** The turn hook read its token from this curl config up to 0.17.19; the file carries the token and goes on boot. */
export const LEGACY_CURL_CONFIG = 'hook-curl.conf'

/** The session environment variable with its space's MCP token, for an agent CLI that takes headers from the env (Codex). */
export const MCP_TOKEN_ENV = 'COCKPIT_MCP_TOKEN'

/** The header with a space's MCP token on every request to the host's brain MCP endpoint (brain-mcp.ts). */
export const MCP_TOKEN_HEADER = 'x-cockpit-mcp-token'

/** The header naming the cockpit session on the brain MCP endpoint; the agent CLI fills it from the session's env. */
export const MCP_SESSION_HEADER = 'x-eml-session'

/**
 * The brain MCP server entry for Claude Code's mcp.json (one per brain space):
 * the host's MCP endpoint over HTTP (brain-mcp.ts), not a process per session.
 * The space's MCP token picks the brain; Claude Code expands
 * ${COCKPIT_SESSION_ID} from each session's environment, so one file serves
 * every session of the space.
 */
export function brainMcpServer(mcpUrl: string, mcpToken: string) {
  return {
    type: 'http',
    url: mcpUrl,
    headers: { [MCP_TOKEN_HEADER]: mcpToken, [MCP_SESSION_HEADER]: '${COCKPIT_SESSION_ID}' },
  }
}

/**
 * Name of the session environment variable that holds the path of the
 * session's EML hook config (its space's). The mcp-server hook reads it when
 * the command names no --config: a provider with one hooks file for every
 * space (Codex) leaves it out, and the hook text stays the same across spaces
 * and boots.
 */
export const EML_HOOK_CONFIG_ENV = 'EML_HOOK_CONFIG'

/**
 * The mcp-server's node hooks (no bash/jq). `configFile`: the space's EML
 * config (Claude Code: one settings.json per space); without it the hook reads
 * the path from EML_HOOK_CONFIG_ENV. `json`: print the context in the hook
 * JSON envelope (Codex).
 */
export function emlHookCommand(
  hook: 'session-start' | 'user-prompt-submit' | 'project-block' | 'stop',
  configFile?: string,
  json = false,
  flags: string[] = [],
): HookCommand {
  // Stable text (paths.ts): node through the host's link, the CLI through app/current.
  return {
    program: hookNode(),
    args: [HOOK_MCP_CLI_JS, 'hook', hook, ...(configFile ? ['--config', configFile] : []), ...(json ? ['--json'] : []), ...flags],
  }
}

/** The EML hooks' own options. */
export const EML_HOOK_OPTIONS = { timeout: 15 }

/**
 * The node the hooks run with. macOS, Linux: <home>/bin/node, a link to this
 * host's node (ensureHookNode). Windows: node itself — a link there needs admin
 * rights or Developer Mode; a node upgrade then changes the hook text once.
 */
export function hookNode(): string {
  return platform.os === 'win32' ? process.execPath : HOOK_NODE
}

/**
 * The node the EML hooks run with: <home>/bin/node, a link to this host's own
 * node. The hook text names the link, not the binary, so a node upgrade (a new
 * Homebrew Cellar path) does not change it — Codex asks the user to trust a
 * hook again whenever its text changes. Pointed at the current node on every
 * boot; call before writing a provider's hooks.
 */
export function ensureHookNode(): string {
  if (platform.os === 'win32') return hookNode()
  fs.mkdirSync(path.dirname(HOOK_NODE), { recursive: true, mode: 0o700 })
  try {
    if (fs.readlinkSync(HOOK_NODE) === process.execPath) return HOOK_NODE
  } catch { /* absent or not a link */ }
  const tmp = `${HOOK_NODE}.${process.pid}`
  fs.rmSync(tmp, { force: true })
  fs.symlinkSync(process.execPath, tmp)
  fs.renameSync(tmp, HOOK_NODE)
  return HOOK_NODE
}

/**
 * The EML client config of one brain space, read by that space's EML hooks:
 * the host's hook routes (brain-mcp.ts HOOKS_PATH) as the EML API, with the
 * space's per-boot MCP token as the bearer. The host answers the boot from the
 * bound agent's brain and the space; no brain token reaches a session.
 */
export function writeEmlHookConfig(file: string, hooksUrl: string, mcpToken: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  fs.writeFileSync(
    file,
    `# EML client config for the cockpit's session hooks — rewritten on every boot.\nEML_URL=${hooksUrl}\nEML_API_TOKEN=${mcpToken}\n`,
    { mode: 0o600 },
  )
  fs.chmodSync(file, 0o600)
}

const SKILL_MARKER = 'managed-by: engramprotocol-setup'

/**
 * Copy the skills of `sourceDirs` (<dir>/<name>/SKILL.md) into a provider's
 * config dir (<configDir>/skills/<name>/SKILL.md — the layout Claude Code and
 * Codex share), refreshed on every boot. A skill of the same name without the
 * managed marker is the user's own and is left alone.
 */
export function installManagedSkills(sourceDirs: string[], configDir: string): void {
  for (const dir of sourceDirs) {
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      const source = path.join(dir, name, 'SKILL.md')
      if (!fs.existsSync(source)) continue
      const targetDir = path.join(configDir, 'skills', name)
      const target = path.join(targetDir, 'SKILL.md')
      if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').includes(SKILL_MARKER)) continue
      fs.mkdirSync(targetDir, { recursive: true })
      fs.copyFileSync(source, target)
    }
  }
}
