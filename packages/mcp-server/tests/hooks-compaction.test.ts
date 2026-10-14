import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { compactionNote, contextTokens, growthNudge, GROWTH_STEP_TOKENS } from '../src/hooks/compaction'
import { sessionStart, BOOT_BUDGET_CHARS } from '../src/hooks/index'

const assistant = (cacheRead: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant',
  isSidechain: false,
  message: { usage: { input_tokens: 2, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 100, output_tokens: 50 } },
  ...extra,
})

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

  it('is unknown for a missing file or another format', () => {
    expect(contextTokens(path.join(dir, 'missing.jsonl'))).toBeNull()
    expect(contextTokens(transcript('{"type":"message","payload":{"usage":"n/a"}}', 'not json "usage"'))).toBeNull()
  })

  describe('growth nudge', () => {
    const stateDir = () => path.join(dir, 'state')
    const at = (tokens: number) => growthNudge(stateDir(), { session_id: 's1', transcript_path: transcript(assistant(tokens - 152)) })

    it('nudges once per step since the last save point', () => {
      expect(at(30_000).output).toBe('')
      expect(at(30_000 + GROWTH_STEP_TOKENS - 1).output).toBe('')
      expect(at(30_000 + GROWTH_STEP_TOKENS).output).toMatch(/grown by about 150k tokens.*consolidate skill in auto mode/)
      expect(at(40_000 + GROWTH_STEP_TOKENS).output).toBe('')
      expect(at(30_000 + 2 * GROWTH_STEP_TOKENS).output).toMatch(/auto mode/)
    })

    it('starts counting where it first sees a session, so an old session is not nudged at once', () => {
      expect(at(400_000).output).toBe('')
      expect(at(400_000 + GROWTH_STEP_TOKENS).output).toMatch(/auto mode/)
    })

    it('takes a compaction as the new save point', () => {
      at(30_000)
      expect(at(200_000).output).toMatch(/auto mode/)
      expect(at(60_000).output).toBe('')
      expect(at(60_000 + GROWTH_STEP_TOKENS - 1).output).toBe('')
      expect(at(60_000 + GROWTH_STEP_TOKENS).output).toMatch(/auto mode/)
    })

    it('stays silent without a session id, a transcript or a readable size', () => {
      expect(growthNudge(stateDir(), { transcript_path: transcript(assistant(900_000)) }).output).toBe('')
      expect(growthNudge(stateDir(), { session_id: '../escape', transcript_path: transcript(assistant(900_000)) }).output).toBe('')
      expect(growthNudge(stateDir(), { session_id: 's1' }).output).toBe('')
      expect(growthNudge(stateDir(), { session_id: 's1', transcript_path: path.join(dir, 'missing') }).output).toBe('')
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
