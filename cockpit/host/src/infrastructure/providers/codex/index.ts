import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  AgentProvider, IsolationContext, LaunchRequest, LaunchSpec, SessionRef, SessionSummary, TurnSignal,
} from '../../../domain/agent-provider.js'
import { COCKPIT_SKILLS_DIR, CODEX_CONFIG_DIR, MCP_SKILLS_DIR } from '../../../paths.js'
import {
  COCKPIT_MCP_SERVER, EML_HOOK_CONFIG_ENV, EML_HOOK_OPTIONS, LEGACY_CURL_CONFIG, MCP_ENV_HEADERS, MCP_TOKEN_ENV, TASK_HOOK_OPTIONS, TURN_HOOK_OPTIONS, codexHook,
  emlHookCommand, ensureHookNode, chatCapabilities, installManagedSkills, noMessageInTerminal, taskHookCommand, turnHookCommand, writeTurnHookConfig,
  type HookCommand,
} from '../shared.js'
import type { Capability, ProviderCapabilities } from '../../../domain/agent-provider.js'
import type { ModelOption, SessionRuntimeFactory, SessionRuntimeKind } from '../../../domain/session-runtime.js'
import { createCodexChatRuntimes } from './chat-runtime.js'
import { CodexSignIn, readCodexAccount, type CodexAccount } from './account.js'
import { CodexModels } from './models.js'
import { platform } from '../../platform/index.js'
import { readRolloutSummary } from './session-summary.js'
import { asAgentRuntime } from '../managed-runtime.js'
import { codexRuntime } from './runtime.js'
import { codexSettings, readCodexSettings } from './settings.js'
import { hasTable, removeTables, setTopLevelKey, tomlString, upsertTables } from './toml.js'
import { codexPluginArgs, codexPluginTables } from './plugin-servers.js'
import { hooksSourcePath, trustOwnHooks, type CodexHooks } from './hook-trust.js'
import type { McpServerConfig } from '../../../domain/space-plugins.js'

/**
 * Codex CLI as an agent provider (ARCHITECTURE.md, "Spike findings").
 *
 * The app's own Codex environment is one directory, CODEX_HOME =
 * <home>/codex-config: sign-in, config.toml, hooks.json and the sessions live
 * there, fully separate from the user's ~/.codex. Sessions run in the user's
 * real projects (cwd = project path).
 *
 * One Codex home serves every brain space, so nothing written here names a
 * brain. A session gets its space through its environment instead: the
 * space's per-boot MCP token (COCKPIT_MCP_TOKEN) and its session id, which
 * Codex sends as headers to the host's MCP endpoints (`env_http_headers`
 * in config.toml; brain-mcp.ts, cockpit-mcp.ts), and EML_HOOK_CONFIG, the path of the space's
 * EML hook config, which the EML hooks read themselves (see shared.ts,
 * EML_HOOK_CONFIG_ENV). No brain token reaches a session.
 *
 * Files written here:
 *   - config.toml: Codex's own update check off; the brain MCP server (eml_brain,
 *     the host's endpoint over streamable HTTP) with its tool calls pre-approved
 *     (Codex asks per call otherwise, and fails the call where nobody can
 *     answer), and the same way the cockpit's own session tools (cockpit, the
 *     host's endpoint for terminal sessions: end_turn, schedule, send_message,
 *     list_sessions); one `projects."<path>"` table per trusted folder; the
 *     trust of the cockpit's own hooks (hooks.json, below). Codex keeps
 *     its own state in the same file, so only these tables are replaced. No
 *     token in it.
 *   - turn-hook.json (chmod 600): URL and per-boot token for the turn-state hook.
 *   - hooks.json: turn state to the host, and the EML hooks (boot, project block, reminder,
 *     consolidate at stop).
 *     Codex runs a hook only once its current text is trusted. The cockpit
 *     trusts its own hooks right after writing them (hook-trust.ts: one
 *     `hooks.state` table per hook in config.toml, only for this hooks.json),
 *     so neither the chat nor a terminal waits for the user's "Trust all".
 *     Nothing per boot or per space is in the hook text, so the file and its
 *     trust stay the same from boot to boot.
 *
 *   - skills/<name>/SKILL.md: the EML skills (consolidate, checkpoint,
 *     getting-started) from the bundled mcp-server and the cockpit's own
 *     (spawn-session, task-run), refreshed each boot. The folders those two
 *     write to — the spawn inbox, the tasks folder — are extra writable roots
 *     of the sandbox (config.toml, sandbox_workspace_write).
 *
 * A session runs in the chat through `codex app-server`
 * (chat-runtime.ts), workers too, and can be sent a message
 * there. With Settings › Advanced › Terminal fallback on, the user can open one in a
 * terminal instead (launch below): the same home, hooks and MCP servers either way.
 *
 * The binary is the cockpit's own (runtime.ts), installed when the user sets
 * Codex up; sign-in is Codex's own screen in the pane. What a session may do
 * without asking is the user's setting (settings.ts).
 */

/**
 * Codex cuts a hook's context off at about 2,500 tokens unless the hook raises
 * the limit. The boot context of a grown brain is larger than that, and so is
 * a full project block.
 */
const BOOT_CONTEXT_LIMIT = 20_000

/**
 * How long a permission request may stay unanswered in auto mode before the
 * session counts as waiting for the user. A review took 3–4 s when tried.
 */
const REVIEW_SETTLE_MS = 12_000

const CONFIG_TOML = path.join(CODEX_CONFIG_DIR, 'config.toml')
const HOOKS_JSON = path.join(CODEX_CONFIG_DIR, 'hooks.json')
const TURN_HOOK_CONFIG = path.join(CODEX_CONFIG_DIR, 'turn-hook.json')

function readConfig(): string {
  try { return fs.readFileSync(CONFIG_TOML, 'utf8') } catch { return '' }
}

/** The plugin servers config.toml holds now, by space (writeCodexPluginServers). */
let pluginServerNames: Record<string, string[]> = {}
/** Which tables of config.toml are plugin servers, so the next write replaces exactly those. */
const PLUGIN_SERVERS_FILE = path.join(CODEX_CONFIG_DIR, 'plugin-servers.json')

/**
 * Writes the spaces' plugin servers into the shared config.toml, each off until a session of its
 * space switches it on (plugin-servers.ts). Called at boot once the spaces are open and after every
 * change of a space's plugins.
 */
export function writeCodexPluginServers(bySpace: Record<string, Record<string, McpServerConfig>>): void {
  // Without Codex set up (prepare writes config.toml) there is nothing to switch on.
  if (!fs.existsSync(CONFIG_TOML)) return
  const { tables, names } = codexPluginTables(bySpace)
  let previous: string[] = []
  try { previous = JSON.parse(fs.readFileSync(PLUGIN_SERVERS_FILE, 'utf8')) as string[] } catch { /* none yet */ }
  writeConfig(upsertTables(removeTables(readConfig(), previous.map((name) => `mcp_servers.${name}`)), tables))
  fs.writeFileSync(PLUGIN_SERVERS_FILE, JSON.stringify(tables.map((table) => table.header.slice('mcp_servers.'.length))), { mode: 0o600 })
  pluginServerNames = names
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
  readonly capabilities: ProviderCapabilities = chatCapabilities(this.label)
  private writableDirs: string[] = []
  /** Codex through its app-server (chat-runtime.ts). */
  private runtimes = createCodexChatRuntimes(undefined, {
    pluginServers: (spaceId) => pluginServerNames[spaceId] ?? [],
    writableDirs: () => this.writableDirs,
  })

  /** Every session runs in the chat; the terminal is only the hidden fallback (terminal-fallback.ts). */
  get chatRuntime(): SessionRuntimeFactory {
    return this.runtimes
  }

  readonly runtime = asAgentRuntime(codexRuntime, 'Settings › Models › Codex › "Set up now" installs it; then reopen this pane.')
  readonly settings = codexSettings

  /**
   * What `account/read` says (account.ts) is a process per call, and the UI
   * asks on every pane title and window focus — so the answer is kept until a
   * sign-in ends, a Codex session ends (it can sign in inside one) or the user
   * asks for a fresh look.
   */
  private accountCache: Promise<CodexAccount | null> | null = null

  readonly auth = {
    signedIn: async () => (await this.account())?.signedIn === true,
    // Another account may offer other models.
    invalidate: () => { this.accountCache = null; this.models.invalidate() },
  }

  /** The models `model/list` offers, from an app-server of its own and kept a while (models.ts). */
  private models = new CodexModels({ version: () => codexRuntime.currentVersion() })

  chatModels(): Promise<ModelOption[]> {
    return this.models.get()
  }

  /** The device-code sign-in through app-server, from Settings › Models (account.ts). */
  readonly signIn = new CodexSignIn({ signedIn: () => this.auth.invalidate() })

  /** The account Codex holds; null when it is not set up or could not say. */
  account(): Promise<CodexAccount | null> {
    if (!codexRuntime.currentVersion()) return Promise.resolve(null)
    this.accountCache ??= readCodexAccount().catch(() => null)
    return this.accountCache
  }

  prepare(ctx: IsolationContext): void {
    this.writableDirs = ctx.writableDirs
    fs.mkdirSync(CODEX_CONFIG_DIR, { recursive: true, mode: 0o700 })
    fs.chmodSync(CODEX_CONFIG_DIR, 0o700)
    ensureHookNode()
    installManagedSkills([MCP_SKILLS_DIR, COCKPIT_SKILLS_DIR], CODEX_CONFIG_DIR)

    // The cockpit updates its own Codex (runtime.ts); Codex's own check would
    // point the user at an install the cockpit does not use.
    const config = setTopLevelKey(readConfig(), 'check_for_update_on_startup', 'false')
    // One of the host's MCP endpoints: the session's space and session id as headers from the
    // session's env (launch), every tool call approved.
    const hostServer = (name: string, url: string) => ({
      header: `mcp_servers.${name}`,
      lines: [
        `url = ${tomlString(url)}`,
        `env_http_headers = { ${Object.entries(MCP_ENV_HEADERS).map(([header, env]) => `${tomlString(header)} = ${tomlString(env)}`).join(', ')} }`,
        'default_tools_approval_mode = "approve"',
      ],
    })
    // Cockpits before brain spaces kept the brain token in an env table here.
    writeConfig(upsertTables(removeTables(config, ['mcp_servers.eml_brain.env']), [
      hostServer('eml_brain', ctx.mcpUrl),
      // The cockpit's own session tools (cockpit-mcp.ts).
      hostServer(COCKPIT_MCP_SERVER, ctx.cockpitMcpUrl),
      {
        // The sandbox confines writes to the project folder; these are the
        // cockpit's own folders a session writes to as well.
        header: 'sandbox_workspace_write',
        lines: [`writable_roots = [${ctx.writableDirs.map(tomlString).join(', ')}]`],
      },
    ]))

    writeTurnHookConfig(TURN_HOOK_CONFIG, ctx.hookUrl, ctx.hookToken)
    // Up to 0.17.19 the turn hook read its token from a curl config.
    fs.rmSync(path.join(CODEX_CONFIG_DIR, LEGACY_CURL_CONFIG), { force: true })
    const entry = (cmd: HookCommand, options: Record<string, unknown>) => ({ hooks: [codexHook(cmd, platform.os, options)] })
    const turn = entry(turnHookCommand(TURN_HOOK_CONFIG), TURN_HOOK_OPTIONS)
    // The EML hooks name no config: they read the space's from the session's
    // env (EML_HOOK_CONFIG_ENV, one hooks file for every space). Codex reads
    // hook output that starts with "[" as JSON — the reminder does — so both
    // come in the JSON envelope.
    const eml = (hook: Parameters<typeof emlHookCommand>[0], json: boolean, options: Record<string, unknown> = {}, flags: string[] = []) =>
      entry(emlHookCommand(hook, undefined, json, flags), { ...EML_HOOK_OPTIONS, ...options })
    const hooks: CodexHooks = {
      // The project block (mcp-server hooks/project-block.ts), as for Claude: a second
      // SessionStart command; it brings the session's project, so the reminder drops
      // its guess from the working directory.
      SessionStart: [
        eml('session-start', true, { additionalContextLimit: BOOT_CONTEXT_LIMIT }),
        eml('project-block', true, { additionalContextLimit: BOOT_CONTEXT_LIMIT }),
        // The session's task (task-hook.ts).
        entry(taskHookCommand(), { ...TASK_HOOK_OPTIONS, additionalContextLimit: BOOT_CONTEXT_LIMIT }),
      ],
      UserPromptSubmit: [turn, eml('user-prompt-submit', true, {}, ['--no-cwd-nudge'])],
      PermissionRequest: [turn],
      // Back to "working" once an approved tool ran — Codex has no other signal for it.
      PostToolUse: [turn],
      // The EML stop hook may block the stop once to consolidate (mcp-server hooks/compaction.ts).
      Stop: [turn, eml('stop', false)],
    }
    fs.writeFileSync(HOOKS_JSON, JSON.stringify({ hooks }, null, 2), { mode: 0o600 })
    fs.chmodSync(HOOKS_JSON, 0o600)
    // The cockpit's hooks are its own: trusted as written, so app-server runs them and a terminal does not ask
    // (hook-trust.ts). Nothing else in the file is trusted here.
    writeConfig(trustOwnHooks(readConfig(), hooksSourcePath(CODEX_CONFIG_DIR), hooks))
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
      // Inline, not fullscreen: in its alternate screen Codex captures the
      // mouse, so the pane can neither scroll its scrollback nor select text.
      '--no-alt-screen',
      ...permissions,
      ...(sandboxed && settings.sandboxNetwork ? ['--config', 'sandbox_workspace_write.network_access=true'] : []),
      // The plugin servers switched on for the session's space.
      ...codexPluginArgs(pluginServerNames[req.space.id] ?? []),
    ]
    const args = req.resume && req.providerSessionId
      ? ['resume', req.providerSessionId, ...options]
      : [...options, ...(req.initialPrompt ? [req.initialPrompt] : [])]
    return {
      bin: codexRuntime.bin,
      // Codex has no remote control: a session lives with its pane.
      keepRunning: false,
      args,
      env: {
        CODEX_HOME: CODEX_CONFIG_DIR,
        // The session's space: Codex sends its MCP token as a header to the
        // host's MCP endpoints (env_http_headers in config.toml); the
        // hooks read the space's config.
        [MCP_TOKEN_ENV]: req.space.mcpToken,
        [EML_HOOK_CONFIG_ENV]: req.space.files.emlConfig,
        // First on the session's PATH. Codex runs shell commands in a login shell,
        // which builds its own PATH — a `codex` typed there can still be the user's.
        PATH: [codexRuntime.binDir, process.env.PATH].filter(Boolean).join(path.delimiter),
      },
    }
  }


  /**
   * Only a session in the chat can be handed a message: the chat bridge sends it in, or resumes the thread for it.
   * One that ran in a terminal is never typed into, and is not moved to the chat for a message either.
   */
  messagingOf(session: { runtime: SessionRuntimeKind } | undefined): Capability {
    const messaging = this.capabilities.messaging
    if (!messaging.supported || session?.runtime !== 'terminal') return messaging
    return { supported: false, reason: noMessageInTerminal(this.label) }
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
   *   UserPromptSubmit, PostToolUse → working   (UserPromptSubmit: the user's prompt, a new turn)
   *   PermissionRequest             → waiting   (Codex is about to ask for approval;
   *                                             in auto mode only once the reviewer had its time)
   *   Stop                          → done
   */
  turnSignal(payload: Record<string, unknown>): TurnSignal | null {
    const providerSessionId = payload.session_id
    if (typeof providerSessionId !== 'string' || !providerSessionId) return null
    switch (payload.hook_event_name) {
      case 'UserPromptSubmit': return { kind: 'turn', providerSessionId, state: 'working', prompt: true }
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

  lastReply(payload: Record<string, unknown>): string {
    return typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : ''
  }

  summary(session: SessionRef): SessionSummary {
    return readRolloutSummary(session.providerSessionId ? findRollout(session.providerSessionId) : null, session.greeted)
  }

  deleteTranscript(session: SessionRef): void {
    const rollout = session.providerSessionId ? findRollout(session.providerSessionId) : null
    if (rollout) try { fs.unlinkSync(rollout) } catch { /* absent */ }
  }
}

export function createCodexProvider(): AgentProvider {
  return new CodexProvider()
}
