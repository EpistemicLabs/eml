import * as fs from 'node:fs'
import { replyLine } from '../../../domain/reply-line.js'
import type { SessionSummary } from '../../../domain/agent-provider.js'
import { firstPromptIsGreeting } from '../../../session-greeting.js'

/**
 * Best-effort display data for a Qwen Code session, read from its chat file
 * (QWEN_HOME/projects/<project>/chats/<id>.jsonl, one JSON record per line).
 * Display-only, like the Codex reader: if Qwen Code changes the layout the
 * sidebar shows "New Session" and the ledger's timestamps, nothing breaks.
 *
 * Records used:
 *   user        message.parts[].text — the user's prompt
 *   assistant   model; usageMetadata.promptTokenCount — what the model had in
 *               context for that request; parts marked `thought` are reasoning
 *   tool_result, system   not messages
 * Qwen Code generates no session title the cockpit reads, so aiTitle stays
 * null. The cockpit's greeting is not the user's first prompt: the summary
 * skips it.
 */

const SUMMARY_MAX = 120
const EMPTY: SessionSummary = {
  summary: null, aiTitle: null, lastActivity: null, messageCount: 0, lastMessageAt: null, lastReply: null, model: null, contextTokens: null,
}

const cache = new Map<string, { mtimeMs: number; greeted: boolean | null; value: SessionSummary }>()

interface ChatRecord {
  type?: unknown
  timestamp?: unknown
  model?: unknown
  message?: { parts?: unknown }
  usageMetadata?: { promptTokenCount?: unknown }
}

function partsText(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null
  for (const part of parts) {
    const { text, thought } = (part ?? {}) as { text?: unknown; thought?: unknown }
    if (thought !== true && typeof text === 'string' && text.trim()) return text
  }
  return null
}

export function readChatSummary(file: string | null, greeted: boolean | null): SessionSummary {
  if (!file) return EMPTY
  let stats: fs.Stats
  try {
    stats = fs.statSync(file)
  } catch {
    return EMPTY
  }
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.greeted === greeted) return cached.value

  let summary: string | null = null
  let firstPromptRead = false
  let messageCount = 0
  let lastMessageAt: string | null = null
  let lastReply: string | null = null
  let model: string | null = null
  let contextTokens: number | null = null
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      let record: ChatRecord
      try { record = JSON.parse(line) } catch { continue }
      if (record.type !== 'user' && record.type !== 'assistant') continue
      if (record.type === 'assistant') {
        if (typeof record.model === 'string') model = record.model
        const tokens = record.usageMetadata?.promptTokenCount
        if (typeof tokens === 'number') contextTokens = tokens
      }
      const text = partsText(record.message?.parts)
      if (!text) continue
      messageCount++
      if (typeof record.timestamp === 'string') lastMessageAt = record.timestamp
      if (record.type === 'assistant') lastReply = replyLine(text) ?? lastReply
      if (record.type === 'user' && !firstPromptRead) {
        firstPromptRead = true
        if (firstPromptIsGreeting(greeted, text)) continue
      }
      if (record.type === 'user' && summary === null) {
        const firstLine = text.trim().split('\n')[0]
        summary = firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX - 1)}…` : firstLine
      }
    }
  } catch {
    return EMPTY
  }
  const value: SessionSummary = {
    summary, aiTitle: null, lastActivity: stats.mtime.toISOString(), messageCount, lastMessageAt, lastReply, model, contextTokens,
  }
  cache.set(file, { mtimeMs: stats.mtimeMs, greeted, value })
  return value
}
