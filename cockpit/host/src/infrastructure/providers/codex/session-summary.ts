import * as fs from 'node:fs'
import type { SessionSummary } from '../../../domain/agent-provider.js'
import { firstPromptIsGreeting } from '../../../session-greeting.js'

/**
 * Best-effort display data for a Codex session, read from its rollout file
 * (one JSON record per line). Display-only, like the Claude Code reader: if
 * Codex changes the layout the sidebar shows "New Session" and the ledger's
 * timestamps, nothing breaks.
 *
 * Records used:
 *   response_item / message   role user | assistant; Codex also files its own
 *                             context as user messages, wrapped in <tags>
 *   turn_context              the turn's model
 *   event_msg / token_count   info.last_token_usage.input_tokens — what the
 *                             model had in context for that request
 * Codex generates no session title of its own, so aiTitle stays null. The
 * cockpit's greeting is not the user's first prompt: the summary skips it.
 */

const SUMMARY_MAX = 120
const EMPTY: SessionSummary = {
  summary: null, aiTitle: null, lastActivity: null, messageCount: 0, lastMessageAt: null, model: null, contextTokens: null,
}

const cache = new Map<string, { mtimeMs: number; greeted: boolean | null; value: SessionSummary }>()

function messageText(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const text = (block as { text?: unknown } | null)?.text
    if (typeof text === 'string' && text.trim()) return text
  }
  return null
}

export function readRolloutSummary(file: string | null, greeted: boolean | null): SessionSummary {
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
  let model: string | null = null
  let contextTokens: number | null = null
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      let record: { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> }
      try { record = JSON.parse(line) } catch { continue }
      const payload = record.payload
      if (!payload) continue
      if (record.type === 'turn_context') {
        if (typeof payload.model === 'string') model = payload.model
      } else if (record.type === 'event_msg' && payload.type === 'token_count') {
        const input = (payload.info as { last_token_usage?: { input_tokens?: unknown } } | null)?.last_token_usage?.input_tokens
        if (typeof input === 'number') contextTokens = input
      } else if (record.type === 'response_item' && payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
        const text = messageText(payload.content)
        // <environment_context> and the like: Codex's own context, not a prompt.
        if (!text || (payload.role === 'user' && text.trimStart().startsWith('<'))) continue
        messageCount++
        if (typeof record.timestamp === 'string') lastMessageAt = record.timestamp
        if (payload.role === 'user' && !firstPromptRead) {
          firstPromptRead = true
          if (firstPromptIsGreeting(greeted, text)) continue
        }
        if (payload.role === 'user' && summary === null) {
          const firstLine = text.trim().split('\n')[0]
          summary = firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX - 1)}…` : firstLine
        }
      }
    }
  } catch {
    return EMPTY
  }
  const value: SessionSummary = {
    summary, aiTitle: null, lastActivity: stats.mtime.toISOString(), messageCount, lastMessageAt, model, contextTokens,
  }
  cache.set(file, { mtimeMs: stats.mtimeMs, greeted, value })
  return value
}
