import * as fs from 'fs'
import * as path from 'path'
import { EML_CONFIG, HOME_DIR, readConfig, type EmlConfig } from '../config'
import { notesUpdate } from './notes'
import { compactionNote, stopHook, type CompactionInput } from './compaction'
import { projectBlockHook } from './project-block'

/**
 * Claude Code hooks as CLI commands (no bash/curl/jq needed, so they run
 * wherever node runs). Embedding apps (the EML cockpit) register them with
 * their own config file:
 *
 *   eml-mcp-server hook session-start      [--config <path>] [--json]
 *   eml-mcp-server hook user-prompt-submit [--config <path>] [--json] [--no-cwd-nudge]
 *   eml-mcp-server hook project-block      [--config <path>] [--json]
 *   eml-mcp-server hook stop               [--config <path>]
 *
 * --json prints the context as the hook JSON envelope
 * ({ hookSpecificOutput: { hookEventName, additionalContext } }) instead of
 * plain text. Codex needs it: it reads stdout that starts with "[" or "{" as
 * JSON, and the reminder starts with "[EML Reminder]". `stop` always prints
 * JSON (a block decision, or nothing): both CLIs read that form for Stop.
 *
 * --config defaults to $EML_HOOK_CONFIG, then ~/.eml/config. Logs and the reminder turn counters live
 * next to the config file (<dir>/logs, <dir>/state), so one config dir = one
 * isolated EML client. A hook never fails the session: every path exits 0.
 * stdout reaches the model's context; nothing else is printed there.
 */

export const REMINDER_TEXT = `[EML Reminder]
- Store-worthy moments (decisions, status changes, tasks, events, feedback rules) → use the matching typed tool (eml_decide / eml_set_status / eml_track_task / eml_note); progress on a task → eml_task_entry.
- Question about customer / project / topic? eml_recall or eml_show first — don't guess from conversation memory.
- Before write: matching active engram exists? skip, or supersede via eml_update (don't duplicate).
- Routine updates: act + inform in 1-2 lines, no permission-asking.
- EML brain is the canonical knowledge base — check it before falling back to conversation memory.`

const PAUSE_MS = 60 * 60 * 1000
const BOOT_TIMEOUT_MS = 8000

interface HookContext {
  configPath: string
  logDir: string
  stateDir: string
}

function contextFor(configPath: string): HookContext {
  const dir = path.dirname(configPath)
  return { configPath, logDir: path.join(dir, 'logs'), stateDir: path.join(dir, 'state') }
}

function logLine(ctx: HookContext, hook: string, line: string): void {
  try {
    fs.mkdirSync(ctx.logDir, { recursive: true, mode: 0o700 })
    const day = new Date().toISOString().slice(0, 10)
    fs.appendFileSync(path.join(ctx.logDir, `${hook}-${day}.log`), `[${new Date().toISOString()}] ${line}\n`)
  } catch { /* logging is best-effort */ }
}

// --- session-start: load the brain via /boot --------------------------------

/**
 * The boot's size budget, in characters, sent to /boot so the server trims
 * the markdown to fit (core/boot.ts, "Size budget"; decision
 * boot-budget-per-harness). This is the Claude Code plain-stdout path:
 * verified in the bundled code of Claude Code 2.1.287 (2026-10-13), a hook's
 * stdout above 10,000 characters (JS string length, per hook) is written to a
 * file and the model only sees a 2,000-char preview — silently. The whole
 * budget is the boot's, except after a compaction: the hint that goes before
 * the boot then (compaction.ts) is taken off it.
 *
 * Not covered yet: Claude Code cuts the JSON envelope (--json,
 * hookSpecificOutput.additionalContext) at 8,000 chars / 200 lines, and Codex
 * — the only consumer of --json today, through its own hook runner — has an
 * unmeasured limit. Both get this value until measured; a harness with a
 * smaller limit needs its own budget here, not a smaller boot in core.
 */
export const BOOT_BUDGET_CHARS = 10_000

export interface BootResult {
  output: string
  log: string
}

export async function sessionStart(
  cfg: EmlConfig | null,
  configPath: string,
  fetchImpl: typeof fetch = fetch,
  budget: number = BOOT_BUDGET_CHARS,
): Promise<BootResult> {
  if (!cfg) {
    return {
      output: `⚠️ EML brain not loaded — no EML config at ${configPath}.`,
      log: 'FAIL config missing',
    }
  }
  if (!cfg.EML_URL || !cfg.EML_API_TOKEN) {
    return {
      output: `⚠️ EML brain not loaded — EML_URL or EML_API_TOKEN missing in ${configPath}.`,
      log: 'FAIL incomplete config',
    }
  }

  let status = 0
  let body: {
    markdown?: string
    version?: string
    legacy?: number
    budget?: {
      limit: number
      chars: number
      situational_title_only: number
      always_title_only?: number
      profiles_title_only?: number
      left_out?: number
      fits: boolean
    }
  } = {}
  try {
    const res = await fetchImpl(`${cfg.EML_URL}/boot`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.EML_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ budget }),
      signal: AbortSignal.timeout(BOOT_TIMEOUT_MS),
    })
    status = res.status
    if (res.ok) body = (await res.json()) as typeof body
  } catch (err) {
    return {
      output: `⚠️ EML boot failed — brain server unreachable at ${cfg.EML_URL}.`,
      log: `FAIL unreachable: ${(err as Error).message}`,
    }
  }

  // A silent "brain not loaded" with no reason cost an hour of debugging once
  // (2026-06-02): an invalid token and an unreachable server must read differently.
  if (status === 401 || status === 403) {
    return {
      output: `⚠️ EML brain NOT loaded — the token was rejected (HTTP ${status}). The token in ${configPath} is invalid or revoked.`,
      log: `FAIL auth ${status}`,
    }
  }
  if (status !== 200 || typeof body.markdown !== 'string') {
    return {
      output: `⚠️ EML boot failed — server error (HTTP ${status}).`,
      log: `FAIL http ${status}`,
    }
  }

  // The log shows what the budget cost, so a shortened boot is visible without
  // debugging: "trim=none" is the normal case, otherwise the entries listed by
  // title only per kind and those left out (e.g. trim=situational:3,always:1).
  // OVER-BUDGET means the system rules and the first two profiles alone exceed
  // the limit. legacy = entries shown by title only until they are rewritten
  // in the short format.
  const b = body.budget
  const parts = b ? ([
    ['situational', b.situational_title_only],
    ['always', b.always_title_only],
    ['profiles', b.profiles_title_only],
    ['left_out', b.left_out],
  ] as const).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => `${k}:${n}`) : []
  const trim = !b || typeof b.situational_title_only !== 'number' ? 'trim=unknown'
    : !b.fits ? `trim=OVER-BUDGET limit=${b.limit}`
    : parts.length === 0 ? 'trim=none'
    : `trim=${parts.join(',')}`
  const legacy = typeof body.legacy === 'number' ? ` legacy=${body.legacy}` : ''
  return { output: body.markdown, log: `OK ver=${body.version ?? '?'} chars=${body.markdown.length} ${trim}${legacy}` }
}

// --- user-prompt-submit: periodic reminder + scope nudge ---------------------

/** Remind on turn 1, every 5th turn, and after a pause of more than an hour. */
export function shouldRemind(turn: number, msSinceLastTurn: number | null): boolean {
  return turn === 1 || turn % 5 === 0 || (msSinceLastTurn !== null && msSinceLastTurn > PAUSE_MS)
}

/**
 * The reminder, plus a nudge naming the likely active project (basename(cwd) ==
 * project id). A host that delivers the project block (hook project-block)
 * passes --no-cwd-nudge: the session then gets the project itself, not a guess.
 */
export function reminderFor(cwd: string, home: string = HOME_DIR, cwdNudge = true): string {
  const projectId = cwd ? path.basename(cwd) : ''
  if (!cwdNudge || !cwd || cwd === home || !projectId) return REMINDER_TEXT
  return `${REMINDER_TEXT}\n- Active working dir: ${cwd} — if \`project.${projectId}\` is a tracked project, call \`eml_show project.${projectId}\` FIRST to load its status, open tasks and project-specific rules before editing code or making decisions in it.`
}

const SAFE_SESSION_ID = /^[A-Za-z0-9_.-]+$/

export function userPromptSubmit(
  ctx: HookContext,
  input: { session_id?: string; cwd?: string },
  now: number = Date.now(),
  cwdNudge = true,
): BootResult {
  const sessionId = input.session_id ?? ''
  const cwd = input.cwd || process.cwd()
  if (!SAFE_SESSION_ID.test(sessionId)) return { output: '', log: 'no usable session_id, silent' }

  const turnsDir = path.join(ctx.stateDir, 'turns')
  const counterFile = path.join(turnsDir, sessionId)
  let turn = 0
  let msSinceLast: number | null = null
  try {
    turn = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0
    msSinceLast = now - fs.statSync(counterFile).mtimeMs
  } catch { /* first turn of this session */ }
  turn += 1
  try {
    fs.mkdirSync(turnsDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(counterFile, String(turn))
  } catch { /* a lost counter only means an extra reminder */ }

  if (!shouldRemind(turn, msSinceLast)) return { output: '', log: `silent turn=${turn} sid=${sessionId}` }
  return { output: reminderFor(cwd, HOME_DIR, cwdNudge), log: `reminded turn=${turn} sid=${sessionId} cwd=${cwd}` }
}

// --- CLI dispatch -------------------------------------------------------------

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const HOOK_EVENT = { 'session-start': 'SessionStart', 'user-prompt-submit': 'UserPromptSubmit', 'project-block': 'SessionStart' } as const

/** What a hook prints: the context as it is, or wrapped in the hook JSON envelope. */
export function formatHookOutput(hook: keyof typeof HOOK_EVENT, output: string, json: boolean): string {
  return json
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT[hook], additionalContext: output } })
    : output
}

export async function runHook(argv: string[]): Promise<void> {
  const name = argv[0]
  const configIdx = argv.indexOf('--config')
  // Without --config: the path in EML_HOOK_CONFIG (a host that writes one
  // hooks file for many brains sets it per session), else ~/.eml/config.
  const configFile = configIdx >= 0 ? argv[configIdx + 1] : process.env.EML_HOOK_CONFIG
  const configPath = configFile ? path.resolve(configFile) : EML_CONFIG
  const ctx = contextFor(configPath)

  let input: { session_id?: string; cwd?: string } & CompactionInput = {}
  try {
    const raw = await readStdin()
    if (raw.trim()) input = JSON.parse(raw)
  } catch { /* no or malformed envelope — hooks still run */ }

  try {
    let result: BootResult
    if (name === 'session-start') {
      // After a compaction the hint comes first: it survives if the output is cut.
      const note = compactionNote(input)
      result = await sessionStart(readConfig(configPath), configPath, fetch, BOOT_BUDGET_CHARS - (note ? note.length + 2 : 0))
      if (note) result = { output: `${note}\n\n${result.output}`, log: `${result.log} compact-note=${note.length}` }
    } else if (name === 'user-prompt-submit') {
      result = userPromptSubmit(ctx, input, Date.now(), !argv.includes('--no-cwd-nudge'))
      // The user's note edits since the last prompt (hooks/notes.ts).
      const notes = await notesUpdate(readConfig(configPath), ctx.stateDir, input)
      logLine(ctx, name, notes.log)
      if (notes.output) result = { ...result, output: [result.output, notes.output].filter(Boolean).join('\n\n') }
    } else if (name === 'project-block') {
      // The project's context on every session start (hooks/project-block.ts).
      result = await projectBlockHook(readConfig(configPath), input)
    } else if (name === 'stop') {
      // Consolidate before the session goes idle (hooks/compaction.ts). The
      // output is the block decision as JSON, the same for Claude Code and Codex.
      const stop = stopHook(ctx.stateDir, input)
      if (stop.output) process.stdout.write(stop.output + '\n')
      logLine(ctx, name, stop.log)
      return
    } else {
      process.stderr.write(`Unknown hook "${name ?? ''}". Use: hook session-start | hook user-prompt-submit | hook project-block | hook stop [--config <path>] [--json]\n`)
      return
    }
    if (result.output) process.stdout.write(formatHookOutput(name, result.output, argv.includes('--json')) + '\n')
    logLine(ctx, name, result.log)
  } catch (err) {
    logLine(ctx, name, `FAIL unexpected: ${(err as Error).message}`)
  }
}
