import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  AgentProvider, AgentRuntime, IsolationContext, LaunchRequest, LaunchSpec, SessionRef, SessionSummary, TurnSignal,
} from '../../../domain/agent-provider.js'
import { COCKPIT_SKILLS_DIR, MCP_SKILLS_DIR, QWEN_CONFIG_DIR } from '../../../paths.js'
import {
  EML_HOOK_CONFIG_ENV, EML_HOOK_OPTIONS, MCP_SESSION_HEADER, MCP_TOKEN_ENV, MCP_TOKEN_HEADER, TURN_HOOK_OPTIONS,
  emlHookCommand, ensureHookNode, installManagedSkills, shellLine, turnHookCommand, writeTurnHookConfig, type HookCommand,
} from '../shared.js'
import { asAgentRuntime } from '../managed-runtime.js'
import { qwenRuntime } from './runtime.js'
import { readChatSummary } from './session-summary.js'
import { qwenEndpointSet, qwenSettings, readQwenApiKey, readQwenSettings } from './settings.js'

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
 * puts into the headers to the host's brain MCP endpoint (settings.json
 * expands ${VAR} from the session's env), and EML_HOOK_CONFIG, the path of the
 * space's EML hook config. No brain token reaches a session.
 *
 * Files written here:
 *   - settings.json: telemetry, Qwen Code's own update check, prompt
 *     suggestions and its own auto-memory off (the brain is the memory);
 *     Qwen Code's own scrolling viewport, which survives a pane resize; the
 *     brain MCP server (eml_brain) trusted and its tools loaded up front; the
 *     hooks. Qwen Code keeps its own state in the same file, so only these keys
 *     are replaced. No token in it.
 *   - turn-hook.json (chmod 600): URL and per-boot token for the turn-state hook.
 *   - skills/<name>/SKILL.md: the EML skills and the cockpit's own.
 *
 * The model endpoint (base URL, model, optional key) is the user's setting
 * (settings.ts) and reaches the session as OPENAI_* in its environment. The
 * key is then readable by the model's shell commands; a keyless local
 * endpoint has no such exposure.
 *
 * macOS only for now (registry.ts): the sandbox the cockpit relies on for
 * unattended sessions is Qwen Code's sandbox-exec profile.
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

// --- transcripts --------------------------------------------------------------

/** Qwen Code files a conversation as projects/<project dir>/chats/<id>.jsonl. */
function findChat(providerSessionId: string): string | null {
  const projects = path.join(QWEN_CONFIG_DIR, 'projects')
  let dirs: string[]
  try { dirs = fs.readdirSync(projects) } catch { return null }
  for (const dir of dirs) {
    const file = path.join(projects, dir, 'chats', `${providerSessionId}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return null
}

// --- provider -----------------------------------------------------------------

class QwenProvider implements AgentProvider {
  readonly id = 'qwen' as const
  readonly label = 'Qwen Code'
  /** Qwen Code starts under the cockpit's id (--session-id). */
  readonly adoptsSessionId = true
  readonly messaging = false
  readonly endTurnTool = false
  readonly settings = qwenSettings

  /** The cockpit's own folders a session writes to (IsolationContext), as of the last prepare. */
  private writableDirs: string[] = []

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
    writeSettings({
      ...settings,
      // eml_brain and the hooks are the cockpit's: replaced whole, so nothing an older cockpit wrote lingers.
      mcpServers: {
        ...mcpServers,
        eml_brain: {
          httpUrl: ctx.mcpUrl,
          // The session's space and session id, from the session's env (launch).
          headers: { [MCP_TOKEN_HEADER]: `\${${MCP_TOKEN_ENV}}`, [MCP_SESSION_HEADER]: '${COCKPIT_SESSION_ID}' },
          trust: true,
        },
      },
      hooks: {
        // The project block (mcp-server hooks/project-block.ts), as for Claude: a second
        // SessionStart command; it brings the session's project, so the reminder drops
        // its guess from the working directory.
        SessionStart: [eml('session-start'), eml('project-block')],
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
    // Unattended sessions (workers, task runs) always run in auto mode in the
    // sandbox, whatever the user chose for their own sessions: nobody is
    // watching them, and nobody chose to run them without a sandbox. An
    // attended one follows the user's setting.
    const mode = req.unattended ? 'auto' : settings.permissionMode
    // The sandbox confines the whole CLI, its hooks included: the EML hooks keep
    // their state and logs next to the space's hook config.
    const writable = [...this.writableDirs, path.dirname(req.space.files.emlConfig)].slice(0, MAX_INCLUDE_DIRS)
    const permissions = mode === 'off'
      ? ['--approval-mode', 'yolo']
      : [
        // Qwen Code's classifier allows safe actions and refuses risky ones; in
        // `default` every edit and command comes to the user.
        '--approval-mode', mode === 'auto' ? 'auto' : 'default',
        // Writes stay in the project folder, temp and QWEN_HOME, plus the
        // cockpit's own folders a session writes to and the space's EML folder.
        '--sandbox', 'sandbox-exec',
        ...(writable.length ? ['--include-directories', writable.join(',')] : []),
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
        // host's brain MCP endpoint (settings.json); the hooks read the space's config.
        [MCP_TOKEN_ENV]: req.space.mcpToken,
        [EML_HOOK_CONFIG_ENV]: req.space.files.emlConfig,
        OPENAI_BASE_URL: settings.baseUrl,
        OPENAI_MODEL: settings.model,
        ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
      },
    }
  }

  workerRunsInChat(): boolean {
    return false
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
   *                                             with an empty prompt, after each tool batch)
   *   PermissionRequest             → waiting   (a tool waits for the user's approval)
   *   Stop                          → done
   */
  turnSignal(payload: Record<string, unknown>): TurnSignal | null {
    const providerSessionId = payload.session_id
    if (typeof providerSessionId !== 'string' || !providerSessionId) return null
    switch (payload.hook_event_name) {
      case 'UserPromptSubmit':
      case 'PostToolUse': return { kind: 'turn', providerSessionId, state: 'working' }
      case 'PermissionRequest': return { kind: 'turn', providerSessionId, state: 'waiting' }
      case 'Stop': return { kind: 'turn', providerSessionId, state: 'done' }
      default: return null
    }
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
