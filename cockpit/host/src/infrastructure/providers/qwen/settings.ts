import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AgentSettings } from '../../../domain/agent-provider.js'
import { QWEN_API_KEY_FILE } from '../../../paths.js'
import { readAgentSettings, writeAgentSettings } from '../../../provider-settings.js'
import { platform } from '../../platform/index.js'

/**
 * Qwen Code's settings (Settings › Models › Qwen Code): the model endpoint and
 * how much a session may do without asking. Base URL, model and permission
 * mode live in agents.json; the API key in its own owner-only file
 * (QWEN_API_KEY_FILE), never in agents.json, never back to the UI — `read`
 * only says whether one is set. Apply to sessions started from now on.
 *
 *   baseUrl, model   the OpenAI-compatible endpoint the sessions talk to:
 *                    OpenRouter, a vendor's API or a self-hosted server.
 *   apiKey           optional; a local Ollama or vLLM needs none. Reaches the
 *                    session as OPENAI_API_KEY in its environment — the model's
 *                    shell commands can read it there.
 *   permissionMode
 *     auto (default)  Qwen Code's classifier allows safe actions; risky ones
 *                     come to the user. On macOS in the sandbox too — writes
 *                     stay in the project folder and the cockpit's own folders.
 *     ask             every file edit or shell command comes to the user (on
 *                     macOS in the sandbox).
 *     off             no sandbox and no questions.
 *
 * The sandbox is Qwen Code's sandbox-exec profile, so macOS only. On Linux a
 * session runs as Claude Code's do: without one, its classifier deciding in
 * auto (decision qwen-linux-unattended-classifier-only). `read` says which
 * (`sandboxed`), for the settings' wording.
 *
 * Unattended sessions (workers, task runs) ignore permissionMode and always
 * run in auto: nobody is watching them.
 */

export const QWEN_PERMISSION_MODES = ['auto', 'ask', 'off'] as const
export type QwenPermissionMode = (typeof QWEN_PERMISSION_MODES)[number]

export interface QwenSettings {
  permissionMode: QwenPermissionMode
  baseUrl: string
  model: string
}

const MODE_KEY = 'qwenPermissionMode'
const BASE_URL_KEY = 'qwenBaseUrl'
const MODEL_KEY = 'qwenModel'

/** Whether sessions run in Qwen Code's sandbox (sandbox-exec, macOS) when their mode is not off. */
export const qwenSandboxed = (os: string = platform.os): boolean => os === 'darwin'

const isMode = (value: unknown): value is QwenPermissionMode =>
  (QWEN_PERMISSION_MODES as readonly unknown[]).includes(value)

export function readQwenSettings(): QwenSettings {
  const stored = readAgentSettings()
  return {
    permissionMode: isMode(stored[MODE_KEY]) ? stored[MODE_KEY] : 'auto',
    baseUrl: typeof stored[BASE_URL_KEY] === 'string' ? stored[BASE_URL_KEY] : '',
    model: typeof stored[MODEL_KEY] === 'string' ? stored[MODEL_KEY] : '',
  }
}

/** The endpoint's API key, or null when none is set. */
export function readQwenApiKey(): string | null {
  try {
    return fs.readFileSync(QWEN_API_KEY_FILE, 'utf8').trim() || null
  } catch {
    return null
  }
}

function writeQwenApiKey(key: string): void {
  if (!key) {
    fs.rmSync(QWEN_API_KEY_FILE, { force: true })
    return
  }
  fs.mkdirSync(path.dirname(QWEN_API_KEY_FILE), { recursive: true, mode: 0o700 })
  const tmp = `${QWEN_API_KEY_FILE}.tmp`
  fs.writeFileSync(tmp, key + '\n', { mode: 0o600 })
  fs.renameSync(tmp, QWEN_API_KEY_FILE)
  fs.chmodSync(QWEN_API_KEY_FILE, 0o600)
}

/** Whether sessions have an endpoint to talk to. */
export function qwenEndpointSet(settings: QwenSettings = readQwenSettings()): boolean {
  return settings.baseUrl !== '' && settings.model !== ''
}

function urlProblem(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? null : 'baseUrl must be an http(s) URL'
  } catch {
    return 'baseUrl must be an http(s) URL'
  }
}

export const qwenSettings: AgentSettings = {
  read: () => ({ ...readQwenSettings(), apiKeySet: readQwenApiKey() !== null, sandboxed: qwenSandboxed() }),
  write(patch) {
    const next: Record<string, unknown> = {}
    let apiKey: string | undefined
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'permissionMode') {
        if (!isMode(value)) return `permissionMode must be one of ${QWEN_PERMISSION_MODES.join(', ')}`
        next[MODE_KEY] = value
      } else if (key === 'baseUrl') {
        if (typeof value !== 'string') return 'baseUrl must be a string'
        const trimmed = value.trim()
        const problem = trimmed ? urlProblem(trimmed) : null
        if (problem) return problem
        next[BASE_URL_KEY] = trimmed
      } else if (key === 'model') {
        if (typeof value !== 'string') return 'model must be a string'
        next[MODEL_KEY] = value.trim()
      } else if (key === 'apiKey') {
        // An empty string removes the key.
        if (typeof value !== 'string' || /\s/.test(value.trim())) return 'apiKey must be a string without spaces'
        apiKey = value.trim()
      } else {
        return `unknown setting "${key}"`
      }
    }
    if (Object.keys(next).length) writeAgentSettings(next)
    if (apiKey !== undefined) writeQwenApiKey(apiKey)
    return null
  },
}
