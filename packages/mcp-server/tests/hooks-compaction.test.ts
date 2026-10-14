import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { compactionNote, contextTokens, stopHook, GROWTH_STEP_TOKENS } from '../src/hooks/compaction'
import { sessionStart, BOOT_BUDGET_CHARS } from '../src/hooks/index'

const assistant = (cacheRead: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant',
  isSidechain: false,
  message: { usage: { input_tokens: 2, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 100, output_tokens: 50 } },
  ...extra,
})

// Codex: a token_count event; input_tokens already include the cached ones.
const codexTokenCount = (input: number) => JSON.stringify({
  type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: input - 500, output_tokens: 130, total_tokens: input + 130 }, model_context_window: 258400 } },
})

const reason = (output: string) => {
  const parsed = JSON.parse(output) as { decision: string; reason: string }
  expect(parsed.decision).toBe('block')
  return parsed.reason
}

describe('context size from the transcript', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eml-compaction-test-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  const transcript = (...lines: string[]) => {
    const file = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(file, lines.join('\n') + '\n')
    return file
  }

  it('is the usage of the last response of the main conversation', () => {
    const file = transcript(
      assistant(10_000),
      JSON.stringify({ type: 'user', message: { content: 'the word "usage" in a prompt' } }),
      assistant(40_000),
      assistant(900_000, { isSidechain: true }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 0, output_tokens: 0 } } }),
    )
    expect(contextTokens(file)).toBe(40_152)
  })

  it('reads only the end of a large transcript', () => {
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(4096) } })
    const file = transcript(assistant(10_000), ...Array.from({ length: 400 }, () => filler), assistant(70_000))
    expect(fs.statSync(file).size).toBeGreaterThan(1024 * 1024)
    expect(contextTokens(file)).toBe(70_152)
  })

  it('reads a Codex session file too', () => {
    const file = transcript(
      codexTokenCount(10_000),
      JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
      codexTokenCount(48_000),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
    )
    expect(contextTokens(file)).toBe(48_130)
  })

  it('is unknown for a missing file or another format', () => {
    expect(contextTokens(path.join(dir, 'missing.jsonl'))).toBeNull()
    expect(contextTokens(transcript('{"type":"message","payload":{"usage":"n/a"}}', 'not json "usage"'))).toBeNull()
  })

  describe('stop hook', () => {
    const stateDir = () => path.join(dir, 'state')
    const at = (tokens: number) => stopHook(stateDir(), { session_id: 's1', transcript_path: transcript(assistant(tokens - 152)) })

    it('blocks the stop once per step since the last save point', () => {
      expect(at(30_000).output).toBe('')
      expect(at(30_000 + GROWTH_STEP_TOKENS - 1).output).toBe('')
      expect(reason(at(30_000 + GROWTH_STEP_TOKENS).output)).toMatch(/grown by about 250k tokens.*Before you stop, run the consolidate skill in auto mode/)
      expect(at(40_000 + GROWTH_STEP_TOKENS).output).toBe('')
      expect(reason(at(30_000 + 2 * GROWTH_STEP_TOKENS).output)).toMatch(/auto mode/)
    })

    it('starts counting where it first sees a session, so an old session is not stopped at once', () => {
      expect(at(400_000).output).toBe('')
      expect(reason(at(400_000 + GROWTH_STEP_TOKENS).output)).toMatch(/auto mode/)
    })

    it('takes a compaction as the new save point', () => {
      at(30_000)
      expect(reason(at(50_000 + GROWTH_STEP_TOKENS).output)).toMatch(/auto mode/)
      expect(at(60_000).output).toBe('')
      expect(at(60_000 + GROWTH_STEP_TOKENS - 1).output).toBe('')
      expect(reason(at(60_000 + GROWTH_STEP_TOKENS).output)).toMatch(/auto mode/)
    })

    it('lets the turn it continued end, and blocks again only after the next step', () => {
      at(30_000)
      const file = transcript(assistant(30_000 + GROWTH_STEP_TOKENS))
      expect(stopHook(stateDir(), { session_id: 's1', transcript_path: file, stop_hook_active: true }).output).toBe('')
      expect(reason(stopHook(stateDir(), { session_id: 's1', transcript_path: file }).output)).toMatch(/auto mode/)
      // The consolidation itself grew the context a little: no second block.
      expect(stopHook(stateDir(), { session_id: 's1', transcript_path: transcript(assistant(40_000 + GROWTH_STEP_TOKENS)) }).output).toBe('')
    })

    it('works on a Codex session file', () => {
      const codexAt = (input: number) => stopHook(stateDir(), { session_id: 'c1', transcript_path: transcript(codexTokenCount(input)) })
      expect(codexAt(20_000).output).toBe('')
      expect(reason(codexAt(20_000 + GROWTH_STEP_TOKENS).output)).toMatch(/auto mode/)
    })

    it('stays silent without a session id, a transcript or a readable size', () => {
      expect(stopHook(stateDir(), { transcript_path: transcript(assistant(900_000)) }).output).toBe('')
      expect(stopHook(stateDir(), { session_id: '../escape', transcript_path: transcript(assistant(900_000)) }).output).toBe('')
      expect(stopHook(stateDir(), { session_id: 's1' }).output).toBe('')
      expect(stopHook(stateDir(), { session_id: 's1', transcript_path: null }).output).toBe('')
      expect(stopHook(stateDir(), { session_id: 's1', transcript_path: path.join(dir, 'missing') }).output).toBe('')
      expect(fs.existsSync(stateDir())).toBe(false)
    })
  })
})

describe('hint after a compaction', () => {
  it('comes only when the session start is a compaction, and names the transcript', () => {
    expect(compactionNote({ source: 'startup', transcript_path: '/t.jsonl' })).toBe('')
    expect(compactionNote({ source: 'resume' })).toBe('')
    const note = compactionNote({ source: 'compact', transcript_path: '/work/t.jsonl' })
    expect(note).toMatch(/^## Context was compacted/)
    expect(note).toMatch(/full transcript is at \/work\/t\.jsonl\./)
    expect(note).toMatch(/consolidate skill in auto mode/)
    expect(compactionNote({ source: 'compact' })).not.toMatch(/transcript is at/)
  })

  it('is taken off the budget the boot gets', async () => {
    let sent = 0
    const f = (async (_url: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body).budget
      return { ok: true, status: 200, json: async () => ({ markdown: '# EML Boot', version: '0.17.0' }) }
    }) as unknown as typeof fetch
    await sessionStart({ EML_URL: 'http://a', EML_API_TOKEN: 't' }, '/x', f)
    expect(sent).toBe(BOOT_BUDGET_CHARS)
    await sessionStart({ EML_URL: 'http://a', EML_API_TOKEN: 't' }, '/x', f, BOOT_BUDGET_CHARS - 400)
    expect(sent).toBe(BOOT_BUDGET_CHARS - 400)
  })
})
