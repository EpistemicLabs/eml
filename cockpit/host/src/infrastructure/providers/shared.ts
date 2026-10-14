import * as fs from 'node:fs'
import * as path from 'node:path'
import { HOOK_MCP_CLI_JS, HOOK_NODE, MCP_CLI_JS } from '../../paths.js'
import { HOOK_SESSION_HEADER, HOOK_TOKEN_HEADER } from '../../domain/agent-provider.js'

/**
 * What every provider's isolated config is built from: the brain MCP server,
 * the turn-state hook, and the EML hooks (boot + reminder) with their config.
 */

/** Quote for a POSIX shell command line. */
export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * curl config (-K) holding the hook token, so the token never appears in the
 * hook command line — command lines are visible to every local user via ps.
 */
export function hookCurlConfig(hookToken: string): string {
  return `# Cockpit turn-state hooks — rewritten on every boot.\nheader = "${HOOK_TOKEN_HEADER}: ${hookToken}"\n`
}

/**
 * A hook entry that reports turn state to the host (turn-state.ts) — the
 * shape Claude Code and Codex share. curl streams the hook's stdin JSON to
 * POST /api/hook; the token comes from the curl config file, the cockpit's
 * session id from the session's env. `async` so the CLI never waits on us,
 * `|| true` so a host hiccup can't surface as a hook error. The command holds
 * nothing that changes between boots: Codex asks the user to trust a hook
 * again whenever its text changes.
 */
export function hookEntry(hookUrl: string, curlConfig: string, matcher?: string) {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [{
      type: 'command',
      command: `curl -sS -m 3 -K ${quote(curlConfig)} -X POST -H 'Content-Type: application/json' -H "${HOOK_SESSION_HEADER}: $COCKPIT_SESSION_ID" --data-binary @- ${quote(hookUrl)} >/dev/null 2>&1 || true`,
      timeout: 5,
      async: true,
    }],
  }
}

/** How the brain MCP server (the bundled mcp-server CLI) is started; it reads URL and token from its environment. */
export const BRAIN_MCP_COMMAND = { command: 'node', args: [MCP_CLI_JS] }

/** The two environment variables the brain MCP server reads. */
export const BRAIN_MCP_ENV_VARS = ['EML_API_URL', 'EML_API_TOKEN'] as const

/**
 * The brain MCP server entry for Claude Code's mcp.json (one per brain space).
 * URL and token go in through the environment (read by the mcp-server CLI),
 * not as arguments: arguments show up in every local user's ps output, a
 * process's environment does not.
 */
export function brainMcpServer(loopbackUrl: string, brainToken: string) {
  return {
    ...BRAIN_MCP_COMMAND,
    env: { EML_API_URL: loopbackUrl, EML_API_TOKEN: brainToken },
  }
}

/**
 * Name of the session environment variable that holds the path of the
 * session's EML hook config (its space's). A provider with one hooks file for
 * every space (Codex) points its EML hooks at `"$EML_HOOK_CONFIG"` and the
 * shell fills in the path — the hook text stays the same across spaces and boots.
 */
export const EML_HOOK_CONFIG_ENV = 'EML_HOOK_CONFIG'

/**
 * The mcp-server's node hooks (no bash/jq). `configArg` is the --config
 * argument as it goes on the command line: the quoted path of a space's EML
 * config (Claude Code: one settings.json per space), or `"$EML_HOOK_CONFIG"`
 * (see EML_HOOK_CONFIG_ENV). `json`: print the context in the hook JSON
 * envelope (Codex).
 */
export function emlHookEntry(hook: 'session-start' | 'user-prompt-submit', configArg: string, json = false) {
  return {
    hooks: [{
      type: 'command',
      // Stable text (paths.ts): node through the host's link, the CLI through app/current.
      command: `${quote(HOOK_NODE)} ${quote(HOOK_MCP_CLI_JS)} hook ${hook} --config ${configArg}${json ? ' --json' : ''}`,
      timeout: 15,
    }],
  }
}

/**
 * The node the EML hooks run with: <home>/bin/node, a link to this host's own
 * node. The hook text names the link, not the binary, so a node upgrade (a new
 * Homebrew Cellar path) does not change it — Codex asks the user to trust a
 * hook again whenever its text changes. Pointed at the current node on every
 * boot; call before writing a provider's hooks.
 */
export function ensureHookNode(): string {
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

/** The EML client config (URL + token) of one brain space, read by that space's EML hooks. */
export function writeEmlHookConfig(file: string, loopbackUrl: string, brainToken: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  fs.writeFileSync(
    file,
    `# EML client config for the cockpit's session hooks — rewritten on every boot.\nEML_URL=${loopbackUrl}\nEML_API_TOKEN=${brainToken}\n`,
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
