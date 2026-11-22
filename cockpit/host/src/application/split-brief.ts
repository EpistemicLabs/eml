import type { SplitRelation } from '../domain/split.js'

/**
 * The brief for a split the user starts (Split from here, /split): one short model call over the last
 * turns up to the message they picked, while the session's agent keeps working and nothing is added to
 * its chat. The agent writes the brief itself when it offers a split (offer_split); both follow
 * BRIEF_TEMPLATE, so the new session reads the same shape either way.
 */

/** How many turns before the picked message the brief is written from. */
export const BRIEF_TURNS = 12
/** A long message is cut to this many characters: the brief needs the gist, not the whole paste. */
const TURN_CHARS = 1500

export const BRIEF_TEMPLATE = [
  'Goal: one checkable sentence.',
  'Came up in: the task or session, and the date.',
  'Decided so far: what is settled, one line each.',
  'Open questions: what the new session has to find out or ask.',
  'Files, links, ids: what matters, exactly as they appeared.',
  'Not to redo: what was tried or ruled out.',
].join('\n')

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

/** What the transcript gives: a user message or a block of the agent's text (RuntimeEvent). */
export type TranscriptEvent = { kind: string; id?: string; blockId?: string; text?: string }

/** The user and agent text of a transcript, up to and including the picked item, the last BRIEF_TURNS user turns of it. */
export function turnsFrom(events: TranscriptEvent[], upTo?: string): Turn[] {
  const turns: Turn[] = []
  for (const event of events) {
    const id = event.id ?? event.blockId ?? ''
    if (event.kind === 'user_message' && event.text?.trim()) turns.push({ role: 'user', text: event.text.trim() })
    else if (event.kind === 'text' && event.text?.trim()) {
      const last = turns.at(-1)
      if (last?.role === 'assistant') last.text = `${last.text}\n${event.text.trim()}`
      else turns.push({ role: 'assistant', text: event.text.trim() })
    }
    if (upTo && (id === upTo || id.startsWith(`${upTo}:`))) break
  }
  let users = 0
  let start = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user' && ++users === BRIEF_TURNS) { start = i; break }
  }
  return turns.slice(start).map((t) => ({ ...t, text: t.text.length > TURN_CHARS ? `${t.text.slice(0, TURN_CHARS)} …` : t.text }))
}

export function briefPrompt(turns: Turn[], context: { sessionTitle: string; taskTitle: string | null; projects: Array<{ id: string; name: string }>; today: string }): string {
  return [
    'A user wants to split the latest topic of a chat with an agent off into a task and a session of its own. Write what the new session needs to continue it.',
    `The chat: session "${context.sessionTitle}"${context.taskTitle ? `, working on task ${context.taskTitle}` : ''}. Today is ${context.today}.`,
    'Answer with JSON only, no other text: {"title": "...", "relation": "spun" | "sub" | "unrelated", "projectId": "...", "brief": "..."}',
    '- title: the new topic in two to five words, sentence case.',
    '- relation: "sub" only if the chat\'s task cannot be done without it; "spun" if it grew out of that work; "unrelated" if it has nothing to do with it.',
    `- projectId: the project it belongs to, one of: ${context.projects.map((p) => `${p.id} (${p.name})`).join(', ') || 'none'}.`,
    `- brief: at most 12 lines in this shape, from the turns below only:\n${BRIEF_TEMPLATE}`,
    '',
    'The last turns, oldest first:',
    ...turns.map((t) => `[${t.role}] ${t.text}`),
  ].join('\n')
}

export interface DraftBrief {
  title: string
  relation: SplitRelation
  projectId: string | null
  brief: string
}

/** The model's answer, read tolerantly: the first JSON object in it; null when there is none worth using. */
export function parseBrief(text: string, projectIds: string[]): DraftBrief | null {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  let raw: Record<string, unknown>
  try { raw = JSON.parse(match[0]) as Record<string, unknown> } catch { return null }
  const brief = typeof raw.brief === 'string' ? raw.brief.trim() : ''
  if (!brief) return null
  const relation = raw.relation === 'sub' || raw.relation === 'unrelated' ? raw.relation : 'spun'
  const projectId = typeof raw.projectId === 'string' && projectIds.includes(raw.projectId) ? raw.projectId : null
  return { title: typeof raw.title === 'string' ? raw.title.trim().slice(0, 80) : '', relation, projectId, brief }
}

export interface SplitBriefDeps {
  /** The session's transcript; null for an unknown session. */
  transcript(sessionId: string): Promise<TranscriptEvent[] | null>
  facts(sessionId: string): Promise<{ sessionTitle: string; taskTitle: string | null; projects: Array<{ id: string; name: string }> } | null>
  /** One short model call for the session's space; the answer's text. */
  complete(sessionId: string, prompt: string): Promise<string>
  today(): string
}

export function createSplitBrief(deps: SplitBriefDeps) {
  return {
    async write(sessionId: string, upTo?: string): Promise<{ ok: true; draft: DraftBrief } | { ok: false; reason: 'unknown_session' | 'empty' | 'unreadable' }> {
      const [events, facts] = await Promise.all([deps.transcript(sessionId), deps.facts(sessionId)])
      if (!events || !facts) return { ok: false, reason: 'unknown_session' }
      const turns = turnsFrom(events, upTo)
      if (turns.length === 0) return { ok: false, reason: 'empty' }
      const answer = await deps.complete(sessionId, briefPrompt(turns, { ...facts, today: deps.today() }))
      const draft = parseBrief(answer, facts.projects.map((p) => p.id))
      return draft ? { ok: true, draft } : { ok: false, reason: 'unreadable' }
    },
  }
}

export type SplitBrief = ReturnType<typeof createSplitBrief>
