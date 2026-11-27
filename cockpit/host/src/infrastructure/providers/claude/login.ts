import * as fs from 'node:fs'
import { execFile } from 'node:child_process'
import { AGENTS_FILE, CLAUDE_LOGIN_FILE, COCKPIT_HOME, CONFIG_DIR } from '../../../paths.js'
import { CLAUDE_BIN } from './runtime.js'

/**
 * How cockpit sessions sign in to Claude (Settings › Models). Two modes:
 *
 *   - `login` (default): the regular Claude Code sign-in (/login), kept in the
 *     app's own CLAUDE_CONFIG_DIR — Claude Code stores it per config dir, so the
 *     user's own Claude login is untouched. Claude Code knows the plan (header,
 *     default model, /usage) and refreshes the login itself.
 *   - `token`: a long-lived setup-token (`claude setup-token`) injected as
 *     CLAUDE_CODE_OAUTH_TOKEN — for runtimes without a browser (servers, tests).
 *     Also bills the subscription, but carries no profile, so Claude Code shows
 *     "Claude API" and falls back to its default model.
 *
 * The token lives only in the app home (chmod 600); the browser can write or
 * remove it but never reads it back — status shows a short prefix.
 */

export type LoginMode = 'login' | 'token'
/**
 * Claude Code permission mode for the user's sessions. `auto` (default): Claude
 * Code approves what it judges safe and asks before risky actions — the pane
 * shows as "waiting". `bypassPermissions`: never asks. Worker sessions (opened
 * by another session) always run in `auto`, whatever is set here.
 */
export type PermissionMode = 'auto' | 'bypassPermissions'

// setup-tokens are OAuth tokens (sk-ant-oat…). An API key (sk-ant-api…) would
// bill the API instead of the subscription, so it is refused explicitly.
const OAUTH_PREFIX = 'sk-ant-oat'
const API_KEY_PREFIX = 'sk-ant-api'
const SHAPE = /^[A-Za-z0-9_-]{20,512}$/

export interface ClaudeAccount {
  loggedIn: boolean
  authMethod: string | null
  subscriptionType: string | null
  email: string | null
}

export interface ClaudeLoginStatus {
  mode: LoginMode
  /** The space's own agent keeps its own login: the setup-token mode does not reach its sessions. */
  ownLogin: boolean
  permissionMode: PermissionMode
  token: { set: boolean; prefix: string | null }
  account: ClaudeAccount | null
}

// --- token --------------------------------------------------------------------

export function readClaudeLogin(): string | null {
  try {
    const token = fs.readFileSync(CLAUDE_LOGIN_FILE, 'utf8').trim()
    return token || null
  } catch {
    return null
  }
}

/** Validate + store. Returns an error message for the UI, or null on success. */
export function writeClaudeLogin(raw: unknown): string | null {
  const token = typeof raw === 'string' ? raw.replace(/\s+/g, '') : ''
  if (!token) return 'Paste the token printed by `claude setup-token`.'
  if (token.startsWith(API_KEY_PREFIX)) {
    return 'This is an API key — it would bill the API, not your subscription. Use the token from `claude setup-token`.'
  }
  if (!token.startsWith(OAUTH_PREFIX) || !SHAPE.test(token)) {
    return 'That does not look like a token from `claude setup-token` (it starts with sk-ant-oat).'
  }
  fs.mkdirSync(COCKPIT_HOME, { recursive: true, mode: 0o700 })
  fs.writeFileSync(CLAUDE_LOGIN_FILE, token + '\n', { mode: 0o600 })
  fs.chmodSync(CLAUDE_LOGIN_FILE, 0o600)
  return null
}

export function clearClaudeLogin(): void {
  fs.rmSync(CLAUDE_LOGIN_FILE, { force: true })
  // Without a token the token mode has nothing to inject — fall back to login.
  if (readLoginMode() === 'token') writeLoginMode('login')
}

// --- agent settings (agents.json) ---------------------------------------------

function readAgentSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function writeAgentSettings(patch: Record<string, unknown>): void {
  fs.mkdirSync(COCKPIT_HOME, { recursive: true, mode: 0o700 })
  const next = { ...readAgentSettings(), ...patch }
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
}

export function readLoginMode(): LoginMode {
  return readAgentSettings().loginMode === 'token' ? 'token' : 'login'
}

export function readPermissionMode(): PermissionMode {
  return readAgentSettings().permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'auto'
}

/** Whether the one-time switch of Claude Code's theme to `auto` has run (isolation.ts). */
export function claudeThemeMigrated(): boolean {
  return readAgentSettings().claudeThemeAuto === true
}

export function markClaudeThemeMigrated(): void {
  writeAgentSettings({ claudeThemeAuto: true })
}

/** Returns an error message for the UI, or null on success. */
export function writeLoginMode(raw: unknown): string | null {
  if (raw !== 'login' && raw !== 'token') return 'Unknown sign-in mode.'
  if (raw === 'token' && !readClaudeLogin()) return 'Save a setup-token first.'
  writeAgentSettings({ loginMode: raw })
  return null
}

/** Returns an error message for the UI, or null on success. */
export function writePermissionMode(raw: unknown): string | null {
  if (raw !== 'auto' && raw !== 'bypassPermissions') return 'Unknown permission mode.'
  writeAgentSettings({ permissionMode: raw })
  return null
}

export interface AgentPatch { mode?: unknown; permissionMode?: unknown }

/** PATCH body of /api/agents/login: { mode?, permissionMode? }. Stored keys of settings that are gone (chatView, renderer, remoteControl) are ignored. */
export function writeAgentPatch(body: AgentPatch | null): string | null {
  if (body?.mode === undefined && body?.permissionMode === undefined) return 'Nothing to change.'
  if (body.mode !== undefined) {
    const error = writeLoginMode(body.mode)
    if (error) return error
  }
  return body.permissionMode !== undefined ? writePermissionMode(body.permissionMode) : null
}

/** The token a session gets injected — only in token mode. */
export function sessionToken(): string | null {
  return readLoginMode() === 'token' ? readClaudeLogin() : null
}

// --- account (what Claude Code itself reports for a config dir) ---------------

// Per config dir: the shared one, or the folder of a space's own agent.
const accountCache = new Map<string, { at: number; value: ClaudeAccount | null }>()
const ACCOUNT_TTL_MS = 5000

function readAccount(mode: LoginMode, configDir: string): Promise<ClaudeAccount | null> {
  const cached = accountCache.get(configDir)
  if (cached && Date.now() - cached.at < ACCOUNT_TTL_MS) return Promise.resolve(cached.value)
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: '1' }
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  // The setup-token is the shared folder's alternative; a space's own agent always uses its login.
  const token = mode === 'token' && configDir === CONFIG_DIR ? readClaudeLogin() : null
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ['auth', 'status'], { env, timeout: 10_000 }, (_err, stdout) => {
      let value: ClaudeAccount | null = null
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>
        const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
        value = {
          loggedIn: parsed.loggedIn === true,
          authMethod: str(parsed.authMethod),
          subscriptionType: str(parsed.subscriptionType),
          email: str(parsed.email),
        }
      } catch { /* claude missing or unexpected output — status unknown */ }
      accountCache.set(configDir, { at: Date.now(), value })
      resolve(value)
    })
  })
}

export function invalidateAccountCache(): void {
  accountCache.clear()
}

/**
 * Settings › Models' Claude sign-in. `configDir`: the folder whose login is
 * reported — the shared one by default, a space's own agent's folder for that
 * space (`ownLogin`; the setup-token does not apply there); null for an agent
 * without a Claude Code folder.
 */
export async function claudeLoginStatus(configDir: string | null = CONFIG_DIR): Promise<ClaudeLoginStatus> {
  const token = readClaudeLogin()
  const mode = readLoginMode()
  return {
    mode,
    ownLogin: configDir !== CONFIG_DIR,
    permissionMode: readPermissionMode(),
    token: { set: token !== null, prefix: token ? `${token.slice(0, 16)}…` : null },
    account: configDir ? await readAccount(mode, configDir) : null,
  }
}
