import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  AgentProvider, IsolationContext, LaunchRequest, LaunchSpec, SessionRef, SessionSummary, TurnSignal,
} from '../../../domain/agent-provider.js'
import { COCKPIT_SKILLS_DIR, CODEX_CONFIG_DIR, MCP_SKILLS_DIR } from '../../../paths.js'
import { BRAIN_MCP_COMMAND, BRAIN_MCP_ENV_VARS, EML_HOOK_CONFIG_ENV, emlHookEntry, ensureHookNode, hookCurlConfig, hookEntry, installManagedSkills } from '../shared.js'
import { readRolloutSummary } from './session-summary.js'
import { asAgentRuntime } from '../managed-runtime.js'
import { codexRuntime } from './runtime.js'
import { codexSettings, readCodexSettings } from './settings.js'
import { hasTable, removeTables, setTopLevelKey, tomlString, upsertTables } from './toml.js'

/**
 * Codex CLI as an agent provider (ARCHITECTURE.md, "Spike findings").
 *
 * The app's own Codex environment is one directory, CODEX_HOME =
 * <home>/codex-config: sign-in, config.toml, hooks.json and the sessions live
 * there, fully separate from the user's ~/.codex. Sessions run in the user's
 * real projects (cwd = project path).
 *
 * One Codex home serves every brain space, so nothing written here names a
 * brain. A session gets its space's brain through its environment instead:
 * EML_API_URL + EML_API_TOKEN, which Codex forwards to the brain MCP server
 * (`env_vars` in config.toml — an MCP server otherwise sees a minimal env),
 * and EML_HOOK_CONFIG, the path of the space's EML hook config, which the
 * hook commands read through the shell (see shared.ts, EML_HOOK_CONFIG_ENV).
 *
 * Files written here:
 *   - config.toml: Codex's own update check off; the brain MCP server (eml_brain)
 *     with its tool calls pre-approved (Codex asks per call otherwise, and
 *     fails the call where nobody can answer); one `projects."<path>"` table
 *     per trusted folder. Codex keeps its own state in the same file, so only
 *     these tables are replaced. No token in it.
 *   - hook-curl.conf (chmod 600): the per-boot hook token as a curl header.
 *   - hooks.json: turn state to the host, and the EML hooks (boot, reminder, consolidate at stop).
 *     Codex runs a hook only after the user trusted it; it asks once, in the
 *     first session, and again whenever a hook's text changes — which is why
 *     nothing per boot or per space is in the hook text.
 *
 *   - skills/<name>/SKILL.md: the EML skills (consolidate, checkpoint,
 *     getting-started) from the bundled mcp-server and the cockpit's own
 *     (spawn-session, task-run), refreshed each boot. The folders those two
 *     write to — the spawn inbox, the tasks folder — are extra writable roots
 *     of the sandbox (config.toml, sandbox_workspace_write).
 *
 * The binary is the cockpit's own (runtime.ts), installed when the user sets
 * Codex up; sign-in is Codex's own screen in the pane. What a session may do
 * without asking is the user's setting (settings.ts).
 */

/**
 * Codex cuts a hook's context off at about 2,500 tokens unless the hook raises
 * the limit. The boot context of a grown brain is larger than that.
 */
const BOOT_CONTEXT_LIMIT = 20_000

/**
 * How long a permission request may stay unanswered in auto mode before the
 * session counts as waiting for the user. A review took 3–4 s when tried.
 */
const REVIEW_SETTLE_MS = 12_000

const CONFIG_TOML = path.join(CODEX_CONFIG_DIR, 'config.toml')
const HOOKS_JSON = path.join(CODEX_CONFIG_DIR, 'hooks.json')
const CURL_CONFIG = path.join(CODEX_CONFIG_DIR, 'hook-curl.conf')

function readConfig(): string {
  try { return fs.readFileSync(CONFIG_TOML, 'utf8') } catch { return '' }
}

function writeConfig(text: string): void {
  fs.mkdirSync(CODEX_CONFIG_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${CONFIG_TOML}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, CONFIG_TOML)
  fs.chmodSync(CONFIG_TOML, 0o600)
}

// --- transcripts --------------------------------------------------------------

/** Codex files a conversation as sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl. */
function findRollout(providerSessionId: string): string | null {
  const walk = (dir: string, depth: number): string | null => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && depth > 0) {
        const found = walk(full, depth - 1)
        if (found) return found
      } else if (entry.isFile() && entry.name.endsWith(`-${providerSessionId}.jsonl`)) {
        return full
      }
    }
    return null
  }
  return walk(path.join(CODEX_CONFIG_DIR, 'sessions'), 3)
}

// --- provider -----------------------------------------------------------------

class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const
  readonly label = 'Codex'
  /** Codex assigns the session id itself and reports it with the first hook. */
  readonly adoptsSessionId = false

  readonly runtime = asAgentRuntime(codexRuntime, 'Settings › Models › Codex › "Set up now" installs it; then reopen this pane.')
  readonly settings = codexSettings

  /**
   * `codex login status` is a process per call, and the UI asks on every pane
   * title and window focus — so the answer is kept until a Codex session ends
   * (the sign-in happens inside one) or the user asks for a fresh look.
   */
  private signedInCache: Promise<boolean> | null = null

  readonly auth = {
    signedIn: () => {
      if (!codexRuntime.currentVersion()) return Promise.resolve(false)
      this.signedInCache ??= new Promise<boolean>((resolve) => {
        // `codex login status` exits 0 only when signed in.
        execFile(codexRuntime.bin, ['login', 'status'], { env: { ...process.env, CODEX_HOME: CODEX_CONFIG_DIR }, timeout: 10_000 }, (err) => resolve(!err))
      })
      return this.signedInCache
    },
    invalidate: () => { this.signedInCache = null },
  }

  prepare(ctx: IsolationContext): void {
    fs.mkdirSync(CODEX_CONFIG_DIR, { recursive: true, mode: 0o700 })
    fs.chmodSync(CODEX_CONFIG_DIR, 0o700)
    ensureHookNode()
    installManagedSkills([MCP_SKILLS_DIR, COCKPIT_SKILLS_DIR], CODEX_CONFIG_DIR)

    // The cockpit updates its own Codex (runtime.ts); Codex's own check would
    // point the user at an install the cockpit does not use.
    const config = setTopLevelKey(readConfig(), 'check_for_update_on_startup', 'false')
    // Cockpits before brain spaces kept the brain token in an env table here.
    writeConfig(upsertTables(removeTables(config, ['mcp_servers.eml_brain.env']), [
      {
        header: 'mcp_servers.eml_brain',
        lines: [
          `command = ${tomlString(BRAIN_MCP_COMMAND.command)}`,
          `args = [${BRAIN_MCP_COMMAND.args.map(tomlString).join(', ')}]`,
          // The session's brain: forwarded from the session's env (launch).
          `env_vars = [${BRAIN_MCP_ENV_VARS.map(tomlString).join(', ')}]`,
          'default_tools_approval_mode = "approve"',
        ],
      },
      {
        // The sandbox confines writes to the project folder; these are the
        // cockpit's own folders a session writes to as well.
        header: 'sandbox_workspace_write',
        lines: [`writable_roots = [${ctx.writableDirs.map(tomlString).join(', ')}]`],
      },
    ]))

    fs.writeFileSync(CURL_CONFIG, hookCurlConfig(ctx.hookToken), { mode: 0o600 })
    fs.chmodSync(CURL_CONFIG, 0o600)
    const turn = hookEntry(ctx.hookUrl, CURL_CONFIG)
    // The EML hooks read the space's config from the session's env (one hooks
    // file for every space). Codex reads hook output that starts with "[" as
    // JSON — the reminder does — so both come in the JSON envelope.
    const emlConfigArg = `"$${EML_HOOK_CONFIG_ENV}"`
    const boot = emlHookEntry('session-start', emlConfigArg, true)
    fs.writeFileSync(
      HOOKS_JSON,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: boot.hooks.map((hook) => ({ ...hook, additionalContextLimit: BOOT_CONTEXT_LIMIT })) }],
          UserPromptSubmit: [turn, emlHookEntry('user-prompt-submit', emlConfigArg, true)],
          PermissionRequest: [turn],
          // Back to "working" once an approved tool ran — Codex has no other signal for it.
          PostToolUse: [turn],
          // The EML stop hook may block the stop once to consolidate (mcp-server hooks/compaction.ts).
          Stop: [turn, emlHookEntry('stop', emlConfigArg)],
        },
      }, null, 2),
      { mode: 0o600 },
    )
    fs.chmodSync(HOOKS_JSON, 0o600)
  }

  trustProject(projectPath: string): void {
    const header = `projects.${tomlString(projectPath)}`
    const config = readConfig()
    // A table that exists is the user's (or Codex's) own decision — left alone.
    if (hasTable(config, header)) return
    writeConfig(upsertTables(config, [{ header, lines: ['trust_level = "trusted"'] }]))
  }

  launch(req: LaunchRequest): LaunchSpec {
    const settings = readCodexSettings()
    const sandbox = ['--sandbox', 'workspace-write']
    // Who answers a request to go beyond the sandbox: Codex's reviewer model
    // (Auto-review), or the user.
    const reviewer = (who: 'auto_review' | 'user') => ['--config', `approvals_reviewer="${who}"`]
    // Unattended sessions (workers, task runs) always run in auto mode — the
    // sandbox with the reviewer — whatever the user chose for their own
    // sessions: nobody is watching them, and nobody chose to run them without
    // a sandbox. An attended one follows the user's setting.
    const permissions = req.unattended
      ? ['--ask-for-approval', 'on-request', ...sandbox, ...reviewer('auto_review')]
      : settings.permissionMode === 'off'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--ask-for-approval', 'on-request', ...sandbox, ...reviewer(settings.permissionMode === 'auto' ? 'auto_review' : 'user')]
    const sandboxed = req.unattended || settings.permissionMode !== 'off'
    const options = [
      // Without it Codex leaves an app-server daemon behind that outlives the session.
      '--no-daemon',
      ...permissions,
      ...(sandboxed && settings.sandboxNetwork ? ['--config', 'sandbox_workspace_write.network_access=true'] : []),
    ]
    const args = req.resume && req.providerSessionId
      ? ['resume', req.providerSessionId, ...options]
      : [...options, ...(req.initialPrompt ? [req.initialPrompt] : [])]
    return {
      bin: codexRuntime.bin,
      args,
      env: {
        CODEX_HOME: CODEX_CONFIG_DIR,
        // The session's brain, its space's: Codex forwards the first two to the
        // brain MCP server (env_vars in config.toml); the hooks read the third.
        EML_API_URL: req.space.url,
        EML_API_TOKEN: req.space.token,
        [EML_HOOK_CONFIG_ENV]: req.space.files.emlConfig,
        // First on the session's PATH. Codex runs shell commands in a login shell,
        // which builds its own PATH — a `codex` typed there can still be the user's.
        PATH: [codexRuntime.binDir, process.env.PATH].filter(Boolean).join(':'),
      },
    }
  }

  canResume(session: SessionRef): boolean {
    return session.providerSessionId !== null && findRollout(session.providerSessionId) !== null
  }

  resumeNotFound(earlyOutput: string): boolean {
    return /No saved session found/i.test(earlyOutput)
  }

  /**
   * Codex's hooks (hooks.json above):
   *
   *   UserPromptSubmit, PostToolUse → working
   *   PermissionRequest             → waiting   (Codex is about to ask for approval;
   *                                             in auto mode only once the reviewer had its time)
   *   Stop                          → done
   */
  turnSignal(payload: Record<string, unknown>): TurnSignal | null {
    const providerSessionId = payload.session_id
    if (typeof providerSessionId !== 'string' || !providerSessionId) return null
    switch (payload.hook_event_name) {
      case 'UserPromptSubmit':
      case 'PostToolUse': return { kind: 'turn', providerSessionId, state: 'working' }
      case 'PermissionRequest':
        // With Auto-review the request first goes to the reviewer model, which
        // answers within seconds; only what it does not allow reaches the user.
        // Only in ask mode every request is the user's — and even then a worker's
        // goes to the reviewer first, which this cannot tell apart.
        return readCodexSettings().permissionMode !== 'ask'
          ? { kind: 'turn', providerSessionId, state: 'waiting', settleMs: REVIEW_SETTLE_MS }
          : { kind: 'turn', providerSessionId, state: 'waiting' }
      case 'Stop': return { kind: 'turn', providerSessionId, state: 'done' }
      default: return null
    }
  }

  summary(session: SessionRef): SessionSummary {
    return readRolloutSummary(session.providerSessionId ? findRollout(session.providerSessionId) : null)
  }

  deleteTranscript(session: SessionRef): void {
    const rollout = session.providerSessionId ? findRollout(session.providerSessionId) : null
    if (rollout) try { fs.unlinkSync(rollout) } catch { /* absent */ }
  }
}

export function createCodexProvider(): AgentProvider {
  return new CodexProvider()
}
