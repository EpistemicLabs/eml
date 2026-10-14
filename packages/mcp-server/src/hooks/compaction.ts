import * as fs from 'fs'
import * as path from 'path'

/**
 * Consolidate before the context is compacted (docs/proposals/
 * consolidate-before-compact.md). A compaction replaces the conversation with
 * a summary written to continue the task, not to keep what belongs in the
 * brain. No hook can run a skill, and a PreCompact hook cannot put text into
 * the context — so two hooks ask the agent for the consolidate skill's auto
 * mode:
 *
 *   - stopHook (Stop): when the agent ends a turn and the context has grown by
 *     GROWTH_STEP_TOKENS since the session's last save point, the hook blocks
 *     the stop once. The agent consolidates in the same turn, with the full
 *     context and before the session goes idle — an idle session can be
 *     compacted with nobody there to give the agent a turn.
 *   - compactionNote (SessionStart, source "compact"): right after a
 *     compaction, pointing at the transcript that still holds everything.
 *
 * Claude Code and Codex both let a Stop hook block with
 * {"decision":"block","reason"} and mark the continued turn with
 * stop_hook_active. The context size comes from the transcript the agent CLI
 * names in the hook input: the usage of the last response. Neither CLI
 * documents that format as a contract — when it does not parse, the hook stays
 * silent and nothing else changes.
 */

/**
 * A step, not a share of the window: no hook input carries the window size,
 * and a compaction has no fixed trigger point (one session was compacted at
 * about 307k and at about 595k tokens).
 */
export const GROWTH_STEP_TOKENS = 150_000

/** Enough for the last responses; a transcript grows to many megabytes. */
const TAIL_BYTES = 1024 * 1024
const SAFE_SESSION_ID = /^[A-Za-z0-9_.-]+$/

export interface CompactionInput {
  session_id?: string
  transcript_path?: string | null
  source?: string
  stop_hook_active?: boolean
}

type Usage = Record<string, unknown>

const count = (usage: Usage, keys: string[]) =>
  keys.reduce((sum, key) => sum + (typeof usage[key] === 'number' ? (usage[key] as number) : 0), 0)

/**
 * The context size one transcript line records, or null. Claude Code: an
 * assistant response of the main conversation with its usage (cache reads
 * and writes are part of the context). Codex: a token_count event, whose
 * input_tokens already include the cached ones.
 */
function lineTokens(line: string): number | null {
  const entry = JSON.parse(line) as {
    type?: string
    isSidechain?: boolean
    message?: { usage?: Usage }
    payload?: { type?: string; info?: { last_token_usage?: Usage } | null }
  }
  if (entry.type === 'assistant' && entry.isSidechain !== true && entry.message?.usage) {
    return count(entry.message.usage, ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'])
  }
  const codex = entry.type === 'event_msg' && entry.payload?.type === 'token_count' ? entry.payload.info?.last_token_usage : undefined
  return codex ? count(codex, ['input_tokens', 'output_tokens']) : null
}

/** Tokens in the context after the last response of the main conversation, or null when the transcript does not say. */
export function contextTokens(transcriptPath: string): number | null {
  let tail: string
  try {
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const length = Math.min(size, TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, size - length)
      tail = buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    // Cheap filter first; the first line of the tail may be cut and fails to parse.
    if (!line.includes('usage"')) continue
    try {
      const tokens = lineTokens(line)
      if (tokens) return tokens
    } catch { /* not a whole line */ }
  }
  return null
}

export function consolidateReason(grownBy: number): string {
  return `[EML] This session has grown by about ${Math.round(grownBy / 1000)}k tokens since its last save point and may be compacted soon. ` +
    'Before you stop, run the consolidate skill in auto mode and end with its short report. ' +
    'If nothing store-worthy happened since the last save point, say so in one line and stop.'
}

/**
 * The save point is the context size at the session's first stop this hook
 * saw, at the last block, or after the last compaction (the context shrank).
 * One number per session in <stateDir>/context.
 */
export function stopHook(stateDir: string, input: CompactionInput): { output: string; log: string } {
  // The turn is already the continuation this hook asked for: let it end.
  if (input.stop_hook_active === true) return { output: '', log: 'context: continued turn, silent' }
  const sessionId = input.session_id ?? ''
  if (!SAFE_SESSION_ID.test(sessionId) || !input.transcript_path) return { output: '', log: 'context: no session or transcript, silent' }
  const tokens = contextTokens(input.transcript_path)
  if (tokens === null) return { output: '', log: 'context: size unknown, silent' }

  const dir = path.join(stateDir, 'context')
  const file = path.join(dir, sessionId)
  let savePoint: number | null = null
  try {
    const stored = parseInt(fs.readFileSync(file, 'utf8'), 10)
    if (Number.isFinite(stored)) savePoint = stored
  } catch { /* first prompt of this session */ }

  const grownBy = savePoint === null ? 0 : tokens - savePoint
  const block = grownBy >= GROWTH_STEP_TOKENS
  if (savePoint === null || block || grownBy < 0) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, String(tokens))
    } catch { /* a lost save point only moves the next block */ }
  }
  return block
    ? { output: JSON.stringify({ decision: 'block', reason: consolidateReason(grownBy) }), log: `context: blocked tokens=${tokens} grown=${grownBy} sid=${sessionId}` }
    : { output: '', log: `context: tokens=${tokens} grown=${Math.max(grownBy, 0)} sid=${sessionId}` }
}

/** The hint after a compaction; empty for every other session start. */
export function compactionNote(input: CompactionInput): string {
  if (input.source !== 'compact') return ''
  const transcript = input.transcript_path ? ` The full transcript is at ${input.transcript_path}.` : ''
  return '## Context was compacted\n' +
    `The conversation before this point is a summary now.${transcript}\n` +
    'If the compacted part held real work that was not consolidated, run the consolidate skill in auto mode at the next natural stop, ' +
    'not in the middle of a running task: work from the summary and read the transcript where the summary is too thin.'
}
