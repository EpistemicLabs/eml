import type { AgentSettings } from '../../../domain/agent-provider.js'
import { readAgentSettings, writeAgentSettings } from '../../../provider-settings.js'

/**
 * How much a Codex session may do without asking (Settings › Models › Codex
 * permissions), kept in agents.json. Applies to sessions started from now on.
 *
 *   permissionMode
 *     auto (default)  Codex's sandbox — writes stay in the project folder —
 *                     and a second model reviews every request to go beyond
 *                     it (Codex's Auto-review); what it does not allow comes
 *                     to the user. The counterpart of Claude Code's auto mode.
 *     ask             the sandbox, and every such request comes to the user.
 *     off             no sandbox and no questions.
 *   sandboxNetwork    off (default): shell commands in the sandbox have no
 *                     network. on: they do. Codex knows no narrower setting.
 *
 *   chatView          off (default): Codex sessions run in the terminal only.
 *                     on: they can run in the chat view too, through
 *                     `codex app-server` (chat-runtime.ts), workers as well,
 *                     and a session in the chat can be sent a message.
 *   reasoningEffort   default (default): each model thinks as hard as it does
 *                     by default. Otherwise an effort id ("low", "high", …):
 *                     what a chat session starts with, unless it chose its own
 *                     (chat-runtime.ts). A model that does not take it runs
 *                     with its default.
 *
 * Unattended sessions (workers, task runs) ignore permissionMode and always
 * run in auto: nobody is watching them, and nobody chose to run them without
 * a sandbox.
 */

export const CODEX_PERMISSION_MODES = ['auto', 'ask', 'off'] as const
export type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number]

export interface CodexSettings {
  permissionMode: CodexPermissionMode
  sandboxNetwork: boolean
  chatView: boolean
  reasoningEffort: string
}

/** The model's own default effort; any other value is an effort id as `model/list` names them. */
export const DEFAULT_EFFORT = 'default'
const EFFORT_ID = /^[a-z][a-z0-9_-]{0,31}$/

const MODE_KEY = 'codexPermissionMode'
const NETWORK_KEY = 'codexSandboxNetwork'
const CHAT_KEY = 'codexChatView'
const EFFORT_KEY = 'codexReasoningEffort'

const isMode = (value: unknown): value is CodexPermissionMode =>
  (CODEX_PERMISSION_MODES as readonly unknown[]).includes(value)

export function readCodexSettings(): CodexSettings {
  const stored = readAgentSettings()
  return {
    permissionMode: isMode(stored[MODE_KEY]) ? stored[MODE_KEY] : 'auto',
    sandboxNetwork: stored[NETWORK_KEY] === true,
    chatView: stored[CHAT_KEY] === true,
    reasoningEffort: typeof stored[EFFORT_KEY] === 'string' && EFFORT_ID.test(stored[EFFORT_KEY]) ? stored[EFFORT_KEY] : DEFAULT_EFFORT,
  }
}

export const codexSettings: AgentSettings = {
  read: () => ({ ...readCodexSettings() }),
  write(patch) {
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'permissionMode') {
        if (!isMode(value)) return `permissionMode must be one of ${CODEX_PERMISSION_MODES.join(', ')}`
        next[MODE_KEY] = value
      } else if (key === 'sandboxNetwork') {
        if (typeof value !== 'boolean') return 'sandboxNetwork must be true or false'
        next[NETWORK_KEY] = value
      } else if (key === 'chatView') {
        if (typeof value !== 'boolean') return 'chatView must be true or false'
        next[CHAT_KEY] = value
      } else if (key === 'reasoningEffort') {
        if (typeof value !== 'string' || !EFFORT_ID.test(value)) return 'reasoningEffort must be "default" or an effort id such as "low" or "high"'
        next[EFFORT_KEY] = value
      } else {
        return `unknown setting "${key}"`
      }
    }
    writeAgentSettings(next)
    return null
  },
}
