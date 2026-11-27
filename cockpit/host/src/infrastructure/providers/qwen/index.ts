import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  AgentProvider, AgentRuntime, Capability, IsolationContext, LaunchRequest, LaunchSpec, ProviderCapabilities, SessionRef, SessionSpace, SessionSummary, TurnSignal,
} from '../../../domain/agent-provider.js'
import type { ModelOption, SessionRuntimeFactory, SessionRuntimeKind } from '../../../domain/session-runtime.js'
import { COCKPIT_SKILLS_DIR, MCP_SKILLS_DIR, QWEN_CONFIG_DIR } from '../../../paths.js'
import {
  COCKPIT_MCP_SERVER, EML_HOOK_CONFIG_ENV, EML_HOOK_OPTIONS, MCP_ENV_HEADERS, MCP_TOKEN_ENV, TASK_HOOK_OPTIONS, TURN_HOOK_OPTIONS,
  emlHookCommand, ensureHookNode, installManagedSkills, noMessageInTerminal, shellLine, taskHookCommand, terminalOnly, turnHookCommand, withChat, writeTurnHookConfig,
  type HookCommand,
} from '../shared.js'
import { asAgentRuntime } from '../managed-runtime.js'
import { createQwenChatRuntimes } from './chat-runtime.js'
import { findChat } from './chats.js'
import { qwenRuntime } from './runtime.js'
import { readChatSummary } from './session-summary.js'
import { qwenEndpointSet, qwenSandboxed, qwenSettings, readQwenApiKey, readQwenSettings } from './settings.js'

/**
 * Qwen Code as an agent provider, for open and own models behind an
 * OpenAI-compatible endpoint (decision open-models-via-qwen-code-provider).
 *
 * Shaped like the Codex adapter: the app's own Qwen environment is one
 * directory, QWEN_HOME = <home>/qwen-config — settings.json, the chats and
 * Qwen Code's own state live there, fully separate from the user's ~/.qwen.
 * Sessions run in the user's real projects (cwd = project path).
 *
 * One Qwen home serves every brain space, so nothing written here names a
 * brain. A session gets its space through its environment: the space's
 * per-boot MCP token (COCKPIT_MCP_TOKEN) and its session id, which Qwen Code
 * puts into the headers to the host's MCP endpoints (settings.json
 * expands ${VAR} from the session's env), and EML_HOOK_CONFIG, the path of the
 * space's EML hook config. No brain token reaches a session.
 *
 * Files written here:
 *   - settings.json: telemetry, Qwen Code's own update check, prompt
 *     suggestions and its own auto-memory off (the brain is the memory);
 *     Qwen Code's own scrolling viewport, which survives a pane resize; the
 *     brain MCP server (eml_brain) and the cockpit's own session tools
 *     (cockpit, the host's endpoint for terminal sessions) trusted and their
 *     tools loaded up front; the hooks. Qwen Code keeps its own state in the same file, so only these keys
 *     are replaced. No token in it.
 *   - turn-hook.json (chmod 600): URL and per-boot token for the turn-state hook.
 *   - skills/<name>/SKILL.md: the EML skills and the cockpit's own.
 *
 * The model endpoint (base URL, model, optional key) is the user's setting
 * (settings.ts) and reaches the session as OPENAI_* in its environment. The
 * key is then readable by the model's shell commands; a keyless local
 * endpoint has no such exposure.
 *
 * A session runs in a terminal, or, once the user switches the chat view on
 * (settings.ts chatView), in the chat through Qwen Code's SDK (chat-runtime.ts):
 * the same home, hooks and MCP servers either way. With it on, workers run in
 * the chat too, and a session there can be sent a message.
 *
 * Sandbox: on macOS Qwen Code's sandbox-exec profile for every mode but off. On
 * Linux none, as for Claude Code: Qwen Code's own Linux sandboxes do not fit (its
 * tool sandbox refuses MCP servers and SDK sessions, its container sandbox needs
 * Docker), so a session there runs on its classifier alone in auto (decision
 * qwen-linux-unattended-classifier-only).
 */

const SETTINGS_JSON = path.join(QWEN_CONFIG_DIR, 'settings.json')
const TURN_HOOK_CONFIG = path.join(QWEN_CONFIG_DIR, 'turn-hook.json')

/** Qwen Code's sandbox-exec profile has five slots for extra writable folders (INCLUDE_DIR_0..4). */
const MAX_INCLUDE_DIRS = 5

type Json = Record<string, unknown>

function readSettings(): Json {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : {}
  } catch {
    return {}
  }
}

/** `patch` merged into `base`, objects key by key; anything else replaces. */
function merge(base: Json, patch: Json): Json {
  const out: Json = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)
      ? merge(current as Json, value as Json)
      : value
  }
  return out
}

function writeSettings(settings: Json): void {
  const tmp = `${SETTINGS_JSON}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, SETTINGS_JSON)
  fs.chmodSync(SETTINGS_JSON, 0o600)
}

// --- provider -----------------------------------------------------------------

class QwenProvider implements AgentProvider {
  readonly id = 'qwen' as const
  readonly label = 'Qwen Code'
  /** Qwen Code starts under the cockpit's id (--session-id). */
  readonly adoptsSessionId = true
  readonly settings = qwenSettings
  private terminal = terminalOnly(this.label)

  /** The cockpit's own folders a session writes to (IsolationContext), as of the last prepare. */
  private writableDirs: string[] = []

  /** Qwen Code through its SDK (chat-runtime.ts), in the same sandbox a terminal session gets. */
  private runtimes = createQwenChatRuntimes(undefined, {
    sandboxArgs: (mode, space) => this.sandboxArgs(mode === 'yolo', space),
    configuredModel: () => readQwenSettings().model,
  })

  /** The chat view is the user's switch (settings.ts chatView), read each time: it holds from the next session on. */
  get capabilities(): ProviderCapabilities {
    return readQwenSettings().chatView ? withChat(this.terminal) : this.terminal
  }

  /** There exactly while the chat view is on. */
  get chatRuntime(): SessionRuntimeFactory | undefined {
    return readQwenSettings().chatView ? this.runtimes : undefined
  }

  /** An OpenAI-compatible endpoint lists no models to Qwen Code: the one set in the settings. */
  chatModels(): Promise<ModelOption[]> {
    const { model } = readQwenSettings()
    return Promise.resolve(model ? [{ id: model, label: model, description: 'Set in Settings › Models › Qwen Code', resolved: model }] : [])
  }

  /**
   * Qwen Code's sandbox for a session (macOS: sandbox-exec), none for one that runs without (`off`) or where
   * the cockpit has none for it (Linux). Writes stay in the project folder, temp and QWEN_HOME, plus the
   * cockpit's own folders a session writes to and the space's EML folder: the sandbox confines the whole CLI,
   * its hooks included, and the EML hooks keep their state and logs next to the space's hook config.
   */
  private sandboxArgs(off: boolean, space: SessionSpace): string[] {
    if (off || !qwenSandboxed()) return []
    const writable = [...this.writableDirs, path.dirname(space.files.emlConfig)].slice(0, MAX_INCLUDE_DIRS)
    return ['--sandbox', 'sandbox-exec', ...(writable.length ? ['--include-directories', writable.join(',')] : [])]
  }

  /** Sessions need the CLI and a model endpoint to talk to. */
  readonly runtime: AgentRuntime = (() => {
    const runtime = asAgentRuntime(qwenRuntime, 'Settings › Models › Qwen Code: "Set up now" installs it, then set the model endpoint; then reopen this pane.')
    return { ...runtime, problem: () => runtime.problem() ?? (qwenEndpointSet() ? null : 'Qwen Code for the cockpit has no model endpoint yet.') }
  })()

  /** "Signed in" here: an endpoint is set. Read from the settings on every call, so nothing to cache. */
  readonly auth = {
    signedIn: () => Promise.resolve(qwenRuntime.currentVersion() !== null && qwenEndpointSet()),
    invalidate: () => {},
  }

  prepare(ctx: IsolationContext): void {
    fs.mkdirSync(QWEN_CONFIG_DIR, { recursive: true, mode: 0o700 })
    fs.chmodSync(QWEN_CONFIG_DIR, 0o700)
    ensureHookNode()
    installManagedSkills([MCP_SKILLS_DIR, COCKPIT_SKILLS_DIR], QWEN_CONFIG_DIR)

    writeTurnHookConfig(TURN_HOOK_CONFIG, ctx.hookUrl, ctx.hookToken)
    const entry = (cmd: HookCommand, options: Record<string, unknown>) => ({ hooks: [{ type: 'command', command: shellLine(cmd), ...options }] })
    const turn = entry(turnHookCommand(TURN_HOOK_CONFIG), TURN_HOOK_OPTIONS)
    // The EML hooks name no config: they read the space's from the session's
    // env (EML_HOOK_CONFIG_ENV, one settings file for every space). Qwen Code
    // takes plain stdout as context for SessionStart and UserPromptSubmit.
    const eml = (hook: Parameters<typeof emlHookCommand>[0], flags: string[] = []) =>
      entry(emlHookCommand(hook, undefined, false, flags), EML_HOOK_OPTIONS)

    const settings = merge(readSettings(), {
      privacy: { usageStatisticsEnabled: false },
      telemetry: { enabled: false },
      // The cockpit updates its own Qwen Code (runtime.ts).
      general: { disableAutoUpdate: true },
      security: { auth: { selectedType: 'openai' } },
      // Qwen Code's own viewport with mouse tracking (its default): it scrolls on
      // the wheel and selects and copies itself (OSC 52), and redraws cleanly on a
      // resize — its append-only mode leaves gaps in a pane after one. Option-drag
      // still selects in the pane. A prompt suggestion is taken by Enter — a
      // message sent into the pane would submit it.
      ui: { useTerminalBuffer: true, mouseTracking: true, enablePromptSuggestions: false },
      // The brain is the memory.
      memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false },
      // MCP tools up front, not behind tool_search: the boot names the brain tools.
      tools: { toolSearch: { enabled: false } },
    })
    const mcpServers = settings.mcpServers && typeof settings.mcpServers === 'object' ? settings.mcpServers as Json : {}
    // One of the host's MCP endpoints: the session's space and session id from the session's env (launch), trusted.
    const hostServer = (httpUrl: string) => ({
      httpUrl,
      headers: Object.fromEntries(Object.entries(MCP_ENV_HEADERS).map(([header, env]) => [header, `\${${env}}`])),
      trust: true,
    })
    writeSettings({
      ...settings,
      // eml_brain, cockpit and the hooks are the cockpit's: replaced whole, so nothing an older cockpit wrote lingers.
      mcpServers: {
        ...mcpServers,
        eml_brain: hostServer(ctx.mcpUrl),
        // The cockpit's own session tools (cockpit-mcp.ts).
        [COCKPIT_MCP_SERVER]: hostServer(ctx.cockpitMcpUrl),
      },
      hooks: {
        // The project block (mcp-server hooks/project-block.ts), as for Claude: a second
        // SessionStart command; it brings the session's project, so the reminder drops
        // its guess from the working directory.
        // The task hook (task-hook.ts) a third: the session's task, as plain stdout like the others.
        SessionStart: [eml('session-start'), eml('project-block'), entry(taskHookCommand(true), TASK_HOOK_OPTIONS)],
        UserPromptSubmit: [turn, eml('user-prompt-submit', ['--no-cwd-nudge'])],
        PermissionRequest: [turn],
        // Back to "working" once an approved tool ran.
        PostToolUse: [turn],
        // The EML stop hook may block the stop once to consolidate (mcp-server hooks/compaction.ts).
        Stop: [turn, eml('stop')],
      },
    })
    this.writableDirs = ctx.writableDirs
  }

  /** Qwen Code's folder trust is off by default (security.folderTrust): no prompt to answer. */
  trustProject(): void {}

  launch(req: LaunchRequest): LaunchSpec {
    const settings = readQwenSettings()
    const apiKey = readQwenApiKey()
    // Unattended sessions (workers, task runs) always run in auto mode, whatever
    // the user chose for their own sessions: nobody is watching them. An
    // attended one follows the user's setting.
    const mode = req.unattended ? 'auto' : settings.permissionMode
    const permissions = mode === 'off'
      ? ['--approval-mode', 'yolo']
      : [
        // Qwen Code's classifier allows safe actions and refuses risky ones; in
        // `default` every edit and command comes to the user.
        '--approval-mode', mode === 'auto' ? 'auto' : 'default',
        ...this.sandboxArgs(false, req.space),
      ]
    const args = [
      qwenRuntime.bin,
      ...(req.resume && req.providerSessionId ? ['--resume', req.providerSessionId] : ['--session-id', req.sessionId]),
      ...permissions,
      ...(!req.resume && req.initialPrompt ? ['--prompt-interactive', req.initialPrompt] : []),
    ]
    return {
      // The host's node: the bundle needs node 22, and a session's PATH may have none.
      bin: process.execPath,
      // Qwen Code has no remote control: a session lives with its pane.
      keepRunning: false,
      args,
      env: {
        QWEN_HOME: QWEN_CONFIG_DIR,
        // The session's space: Qwen Code sends its MCP token as a header to the
        // host's MCP endpoints (settings.json); the hooks read the space's config.
        [MCP_TOKEN_ENV]: req.space.mcpToken,
        [EML_HOOK_CONFIG_ENV]: req.space.files.emlConfig,
        OPENAI_BASE_URL: settings.baseUrl,
        OPENAI_MODEL: settings.model,
        ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
      },
    }
  }

  /** With the chat view on, a worker runs through the SDK like a chat session the user opened, in the worker's mode (workerMode). */
  workerRunsInChat(): boolean {
    return readQwenSettings().chatView
  }

  /** Only a session in the chat can be handed a message; one that ran in a terminal is never typed into. */
  messagingOf(session: { runtime: SessionRuntimeKind } | undefined): Capability {
    const messaging = this.capabilities.messaging
    if (!messaging.supported || session?.runtime !== 'terminal') return messaging
    return { supported: false, reason: noMessageInTerminal(this.label) }
  }

  canResume(session: SessionRef): boolean {
    return session.providerSessionId !== null && findChat(session.providerSessionId) !== null
  }

  resumeNotFound(earlyOutput: string): boolean {
    return /No saved session found/i.test(earlyOutput)
  }

  /**
   * Qwen Code's hooks (settings.json above):
   *
   *   UserPromptSubmit, PostToolUse → working   (UserPromptSubmit also comes,
   *                                             with an empty prompt, after each tool batch:
   *                                             only one with a prompt is the user's, a new turn)
   *   PermissionRequest             → waiting   (a tool waits for the user's approval)
   *   Stop                          → done
   */
  turnSignal(payload: Record<string, unknown>): TurnSignal | null {
    const providerSessionId = payload.session_id
    if (typeof providerSessionId !== 'string' || !providerSessionId) return null
    switch (payload.hook_event_name) {
      case 'UserPromptSubmit':
        return typeof payload.prompt === 'string' && payload.prompt !== ''
          ? { kind: 'turn', providerSessionId, state: 'working', prompt: true }
          : { kind: 'turn', providerSessionId, state: 'working' }
      case 'PostToolUse': return { kind: 'turn', providerSessionId, state: 'working' }
      case 'PermissionRequest': return { kind: 'turn', providerSessionId, state: 'waiting' }
      case 'Stop': return { kind: 'turn', providerSessionId, state: 'done' }
      default: return null
    }
  }

  lastReply(payload: Record<string, unknown>): string {
    return typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : ''
  }

  summary(session: SessionRef): SessionSummary {
    return readChatSummary(session.providerSessionId ? findChat(session.providerSessionId) : null, session.greeted)
  }

  deleteTranscript(session: SessionRef): void {
    const chat = session.providerSessionId ? findChat(session.providerSessionId) : null
    if (chat) try { fs.unlinkSync(chat) } catch { /* absent */ }
  }
}

export function createQwenProvider(): AgentProvider {
  return new QwenProvider()
}
