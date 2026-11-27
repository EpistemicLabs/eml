import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { removeTables, tableHeaders, tableKey, tableLines, tomlString, upsertTables, type TomlTable } from './toml.js'

/**
 * The cockpit trusts its own Codex hooks itself (index.ts prepare), so a session runs them in the chat
 * (app-server, which never asks) and in a terminal (no "Trust all" prompt).
 *
 * Codex runs a hook of the user's files only once its current text is trusted: `config.toml` holds, per hook,
 * `[hooks.state."<hooks.json path>:<event>:<group>:<handler>"]` with `trusted_hash = "sha256:<hex>"`, and
 * Codex compares that with the hash of the hook as it reads it. Codex's terminal writes these entries on
 * "Trust all" (through app-server's `config/batchWrite`, key path `hooks.state`); this writes the same entries
 * for the cockpit's own hooks.json, and for nothing else.
 *
 * The hash is Codex's own (codex-rs hooks/src/engine/discovery.rs `hook_hash`, config/src/fingerprint.rs
 * `version_for_toml`, codex-cli 0.172.0): SHA-256 of the compact JSON, keys sorted, of
 * `{ event_name: <event in snake_case>, matcher?: <matcher>, hooks: [<the handler, normalized>] }`, where
 * normalized means the timeout and `async` filled in with Codex's defaults. Checked against the `currentHash`
 * `hooks/list` reports for the cockpit's hooks.json and for handlers with a matcher (kept on tool events and
 * SessionStart, dropped on Stop), a status message, a SessionEnd default and a zero timeout. A handler with a field beyond those is not trusted here: its hash
 * would be a guess. Should a later Codex hash differently, its hooks show as modified, and a chat says so
 * (chat-runtime.ts checkHookTrust).
 */

/** A handler as hooks.json holds it. */
export type CodexHookHandler = Record<string, unknown>
export interface CodexHookGroup { matcher?: string; hooks: CodexHookHandler[] }
/** hooks.json's `hooks`: the groups by event name (`SessionStart`, …). */
export type CodexHooks = Record<string, CodexHookGroup[]>

/** The handler fields the hash was checked for. */
const KNOWN_FIELDS = new Set(['type', 'command', 'timeout', 'async', 'statusMessage', 'additionalContextLimit'])

/** Events whose matcher is part of the hook (checked); Codex drops a matcher on Stop. Any other event with a matcher is not hashed. */
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest', 'SessionStart'])
const MATCHERLESS_EVENTS = new Set(['Stop'])

/** `SessionStart` → `session_start`, as Codex names an event in a hook's key and hash. */
export function hookEventKey(event: string): string {
  return event.replace(/[A-Z]/g, (c, i: number) => `${i ? '_' : ''}${c.toLowerCase()}`)
}

/** Codex's timeout: SessionEnd and Interrupt default to 1 s and stop at 3 s; every other event defaults to 600 s. */
function normalizedTimeout(event: string, timeout: unknown): number {
  const given = typeof timeout === 'number' ? timeout : undefined
  if (event === 'SessionEnd' || event === 'Interrupt') return Math.min(Math.max(given ?? 1, 1), 3)
  return Math.max(given ?? 600, 1)
}

const sorted = (value: unknown): unknown => Array.isArray(value)
  ? value.map(sorted)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]))
    : value

/** The hash Codex trusts a command hook by; null for a handler this cannot hash with certainty. */
export function codexHookHash(event: string, matcher: string | undefined, handler: CodexHookHandler): string | null {
  if (handler.type !== 'command' || typeof handler.command !== 'string') return null
  if (Object.keys(handler).some((key) => !KNOWN_FIELDS.has(key))) return null
  const hasMatcher = matcher !== undefined && matcher !== null
  if (hasMatcher && !MATCHER_EVENTS.has(event) && !MATCHERLESS_EVENTS.has(event)) return null
  // TOML has no null: Codex drops an absent value from the identity.
  const fields = Object.fromEntries(Object.entries(handler).filter(([, value]) => value !== null && value !== undefined))
  const identity = {
    event_name: hookEventKey(event),
    ...(hasMatcher && MATCHER_EVENTS.has(event) ? { matcher } : {}),
    hooks: [{ ...fields, timeout: normalizedTimeout(event, handler.timeout), async: handler.async ?? false }],
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(sorted(identity))).digest('hex')}`
}

/**
 * The path Codex names hooks.json by in a hook's key: it resolves links, so a home under a linked folder
 * is named by its real path.
 */
export function hooksSourcePath(codexHome: string): string {
  let dir = codexHome
  try { dir = fs.realpathSync(codexHome) } catch { /* not there yet: as given */ }
  return path.join(dir, 'hooks.json')
}

const STATE = ['hooks', 'state']
const TRUSTED_HASH = /^\s*trusted_hash\s*=/

/**
 * config.toml with the hooks of `hooksPath` trusted as they are now: each one's `trusted_hash` set to its
 * current hash (whatever else its table holds, such as `enabled`, stays), and the entries for hooks the file
 * no longer has removed. Entries for any other file are left as they are.
 */
export function trustOwnHooks(config: string, hooksPath: string, hooks: CodexHooks): string {
  const prefix = `${hooksPath}:`
  const wanted = new Map<string, string>()
  const present = new Set<string>()
  for (const [event, groups] of Object.entries(hooks)) {
    groups.forEach((group, i) => group.hooks.forEach((handler, j) => {
      const key = `${prefix}${hookEventKey(event)}:${i}:${j}`
      present.add(key)
      const hash = codexHookHash(event, group.matcher, handler)
      if (hash) wanted.set(key, hash)
    }))
  }
  const own = (header: string): string | null => {
    const key = tableKey(header)
    return key && key.length === 3 && key[0] === STATE[0] && key[1] === STATE[1] && key[2].startsWith(prefix) ? key[2] : null
  }
  const existing = tableHeaders(config).filter((header) => own(header) !== null)
  const stale = existing.filter((header) => !present.has(own(header) as string))
  const tables: TomlTable[] = [...wanted].map(([key, hash]) => {
    const header = `${STATE.join('.')}.${tomlString(key)}`
    const kept = (tableLines(config, header) ?? []).filter((line) => line.trim() !== '' && !TRUSTED_HASH.test(line))
    return { header, lines: [...kept, `trusted_hash = ${tomlString(hash)}`] }
  })
  const cleaned = stale.length > 0 ? removeTables(config, stale) : config
  return tables.length > 0 ? upsertTables(cleaned, tables) : cleaned
}
