import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  AgentProvider, IsolationContext, LaunchRequest, LaunchSpec, SessionRef, SessionSummary, TurnSignal,
} from '../../../domain/agent-provider.js'
import { claudeLoginStatus, invalidateAccountCache, readPermissionMode, readRenderer, sessionToken } from './login.js'
import { ensureProjectTrusted, writeIsolationFiles, type IsolationFiles } from './isolation.js'
import { CLAUDE_BIN, CLAUDE_BIN_DIR, claudeRuntime } from './runtime.js'
import { asAgentRuntime } from '../managed-runtime.js'
import { deleteTranscript, readSessionSummary } from './session-summary.js'

/**
 * Claude Code as an agent provider: the cockpit's own `claude` (runtime.ts,
 * never the user's install) in the app's CLAUDE_CONFIG_DIR (isolation.ts),
 * signed in there or through a setup-token (login.ts).
 */

// Notification types that mean "Claude stopped and needs the human".
// idle_prompt (60s of inactivity after a turn) adds nothing over `done`.
const WAITING_TYPES = new Set([
  'permission_prompt',
  'worker_permission_prompt',
  'agent_needs_input',
  'elicitation_dialog',
  'elicitation_url_dialog',
])

/** The id Claude Code files the conversation under. */
const transcriptId = (session: SessionRef) => session.providerSessionId ?? session.sessionId

class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const
  readonly label = 'Claude Code'
  readonly adoptsSessionId = true
  private isolation: IsolationFiles | null = null

  readonly runtime = asAgentRuntime(claudeRuntime, 'Settings › Models › Claude Code › "Check now" sets it up; then reopen this pane.')

  readonly auth = {
    signedIn: async () => (await claudeLoginStatus()).account?.loggedIn === true,
    invalidate: () => invalidateAccountCache(),
  }

  /** The shared files; a space's mcp.json and settings.json are written by brain-space.ts (writeSpaceFiles). */
  prepare(ctx: IsolationContext): void {
    this.isolation = writeIsolationFiles(ctx.hookUrl, ctx.hookToken)
  }

  private files(): IsolationFiles {
    if (!this.isolation) throw new Error('claude provider used before prepare()')
    return this.isolation
  }

  trustProject(projectPath: string): void {
    // The project's trust flag lives in the APP's .claude.json — never the user's.
    ensureProjectTrusted(projectPath)
  }

  launch(req: LaunchRequest): LaunchSpec {
    const isolation = this.files()
    const args = [
      // No --strict-mcp-config: the brain MCP is always injected, and MCPs the
      // user sets up inside the cockpit (claude mcp add -s user, claude.ai
      // connectors, plugins, the project's .mcp.json) load too. The user's own
      // ~/.claude.json never reaches a session — CLAUDE_CONFIG_DIR isolates it.
      // Both files are the session's space's: its brain, its hooks.
      '--mcp-config', req.space.files.mcpConfig,
      '--settings', req.space.files.settings, '--setting-sources', 'user,project,local',
      // Permission mode: the user's choice (Settings › Models, default auto);
      // unattended sessions always auto.
      '--permission-mode', req.unattended ? 'auto' : readPermissionMode(),
      // Claude Code adopts the cockpit's id (--session-id), so both ids are the same.
      ...(req.resume ? ['--resume', req.providerSessionId ?? req.sessionId] : ['--session-id', req.sessionId]),
    ]
    if (req.initialPrompt) args.push(req.initialPrompt)
    // Login mode (default): no token — Claude Code uses the sign-in stored in
    // the app's config dir, or asks for one on first start. Token mode: the
    // setup-token from Settings › Models.
    const oauthToken = sessionToken()
    return {
      bin: CLAUDE_BIN,
      args,
      env: {
        CLAUDE_CONFIG_DIR: isolation.configDir,
        // The cockpit updates its own Claude Code (runtime.ts). Claude's own
        // updater would install a native copy into the user's ~/.local.
        DISABLE_AUTOUPDATER: '1',
        // Settings › Models › Terminal: Claude Code's fullscreen renderer keeps
        // the input pinned at the bottom of the pane. /tui cannot switch it
        // inside a cockpit session (launch flags), so it is set at spawn.
        ...(readRenderer() === 'fullscreen' ? { CLAUDE_CODE_NO_FLICKER: '1' } : {}),
        // `claude` typed inside a session is the cockpit's as well.
        PATH: [CLAUDE_BIN_DIR, process.env.PATH].filter(Boolean).join(path.delimiter),
        ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
      },
    }
  }

  /**
   * Whether claude wrote a transcript for this session. Claude Code stores it as
   * `<configDir>/projects/<cwd-slug>/<id>.jsonl` and only after the first turn.
   * Scans every project dir instead of re-deriving the slug — the id is unique
   * and the slug rule (truncation + hash for long paths) is Claude Code's.
   */
  canResume(session: SessionRef): boolean {
    const projectsDir = path.join(this.files().configDir, 'projects')
    try {
      return fs.readdirSync(projectsDir).some((dir) =>
        fs.existsSync(path.join(projectsDir, dir, `${transcriptId(session)}.jsonl`)))
    } catch {
      return false
    }
  }

  resumeNotFound(earlyOutput: string): boolean {
    return /No conversation found/.test(earlyOutput)
  }

  /**
   * Claude Code's hooks (written into the isolated settings.json by isolation.ts):
   *
   *   UserPromptSubmit → working   (the user sent a prompt, Claude is on it)
   *   Stop             → done      (the assistant turn finished)
   *   Notification     → waiting   (permission / elicitation / agent input)
   */
  turnSignal(payload: Record<string, unknown>): TurnSignal | null {
    const providerSessionId = payload.session_id
    if (typeof providerSessionId !== 'string' || !providerSessionId) return null
    switch (payload.hook_event_name) {
      case 'UserPromptSubmit': return { kind: 'turn', providerSessionId, state: 'working' }
      case 'Stop': return { kind: 'turn', providerSessionId, state: 'done' }
      case 'Notification': {
        const type = payload.notification_type
        return typeof type === 'string' && WAITING_TYPES.has(type)
          ? { kind: 'turn', providerSessionId, state: 'waiting' }
          : { kind: 'unclassified', label: String(type) }
      }
      default: return null
    }
  }

  summary(session: SessionRef): SessionSummary {
    return readSessionSummary(session.projectPath, transcriptId(session), session.greeted)
  }

  deleteTranscript(session: SessionRef): void {
    deleteTranscript(session.projectPath, transcriptId(session))
  }
}

export function createClaudeProvider(): AgentProvider {
  return new ClaudeProvider()
}
