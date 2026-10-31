import * as fs from 'node:fs'
import * as path from 'node:path'
import { CONFIG_DIR } from '../../../paths.js'
import { firstPromptIsGreeting } from '../../../session-greeting.js'
import type { SessionSummary } from '../../../domain/agent-provider.js'

/**
 * Best-effort display data for a session, read from the transcript Claude
 * Code keeps in the ISOLATED config dir: `projects/<cwd with "/"→"-">/<id>.jsonl`.
 *
 * It yields `session.summary` (the first user prompt) and `lastActivity`
 * (file mtime), plus the title Claude Code writes for the session itself.
 * Claude Code makes that title from the first prompt once and keeps it; when
 * the first prompt is the cockpit's greeting, the title says nothing about the
 * session and is dropped, and the summary is the user's first prompt after
 * it. It is display-only:
 * spawn/resume decisions never depend on this path convention (decision
 * cockpit-session-resume-strategy) — if the layout changes, the sidebar
 * shows "New Session" and the ledger's timestamps, nothing breaks.
 */

const SUMMARY_MAX = 120
const EMPTY: SessionSummary = {
  summary: null, aiTitle: null, lastActivity: null, messageCount: 0, lastMessageAt: null, model: null, contextTokens: null,
}

const cache = new Map<string, { mtimeMs: number; greeted: boolean | null; value: SessionSummary }>()

// Claude Code names the per-project transcript directory after the cwd with
// every character that is not a letter or digit turned into '-', so
// /Users/x/.eml-cockpit/ws → -Users-x--eml-cockpit-ws. Replacing only the slashes
// (the old rule) missed every path with a dot, underscore or space.
function encodeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-')
}

export function transcriptPathFor(projectPath: string, sessionId: string, configDir: string = CONFIG_DIR): string {
  return path.join(configDir, 'projects', encodeProjectDir(projectPath), `${sessionId}.jsonl`)
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string' && text.trim()) return text
      }
    }
  }
  return null
}

export function readSessionSummary(projectPath: string | null, sessionId: string, greeted: boolean | null, configDir: string = CONFIG_DIR): SessionSummary {
  if (!projectPath) return EMPTY
  const file = transcriptPathFor(projectPath, sessionId, configDir)
  let stats: fs.Stats
  try {
    stats = fs.statSync(file)
  } catch {
    return EMPTY
  }
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.greeted === greeted) return cached.value

  let summary: string | null = null
  let aiTitle: string | null = null
  // null until the first user prompt is read.
  let openedWithGreeting: boolean | null = null
  let messageCount = 0
  let lastMessageAt: string | null = null
  let model: string | null = null
  let contextTokens: number | null = null
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      let record: {
        type?: string
        aiTitle?: unknown
        timestamp?: string
        isMeta?: boolean
        message?: {
          role?: string
          content?: unknown
          model?: string
          usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
        }
      }
      try { record = JSON.parse(line) } catch { continue }
      if (record.type === 'ai-title') {
        if (typeof record.aiTitle === 'string' && record.aiTitle.trim()) aiTitle = record.aiTitle.trim()
        continue
      }
      if (record.type !== 'user' && record.type !== 'assistant') continue
      messageCount += 1
      if (typeof record.timestamp === 'string') lastMessageAt = record.timestamp
      if (record.type === 'assistant') {
        if (typeof record.message?.model === 'string') model = record.message.model
        const usage = record.message?.usage
        if (usage) {
          contextTokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0)
        }
      }
      if (summary === null && record.type === 'user' && !record.isMeta) {
        const text = extractText(record.message?.content)
        if (text && !text.startsWith('<')) {
          if (openedWithGreeting === null) {
            openedWithGreeting = firstPromptIsGreeting(greeted, text)
            if (openedWithGreeting) continue
          }
          const firstLine = text.trim().split('\n')[0]
          summary = firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX - 1)}…` : firstLine
        }
      }
    }
  } catch {
    return EMPTY
  }
  if (openedWithGreeting) aiTitle = null
  const value: SessionSummary = {
    summary, aiTitle, lastActivity: stats.mtime.toISOString(), messageCount, lastMessageAt, model, contextTokens,
  }
  cache.set(file, { mtimeMs: stats.mtimeMs, greeted, value })
  return value
}

/** Delete the transcript (best-effort; the user's isolated config dir). */
export function deleteTranscript(projectPath: string | null, sessionId: string, configDir: string = CONFIG_DIR): void {
  if (!projectPath) return
  try { fs.unlinkSync(transcriptPathFor(projectPath, sessionId, configDir)) } catch { /* absent */ }
}
