import { parseHandoff } from './handoff.js'

/**
 * Where a task stands, in one line, from its newest journal note: the first sentence of the
 * newest handoff's Result (and its Next for the task view), or else the note's first sentence.
 * The agent keeps it current by writing a handoff at every stop; nothing else stores it.
 */
export interface StatusLine {
  now: string
  next: string | null
  at: string
}

/** The longest a status line gets before it is cut at a word. */
export const STATUS_LINE_MAX = 100

/** The first sentence of a text, without its closing period, cut at a word past `max`. */
export function firstSentence(text: string, max = STATUS_LINE_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const end = flat.search(/[.!?](\s|$)/)
  const sentence = (end === -1 ? flat : flat.slice(0, end + 1)).replace(/\.$/, '').trim()
  if (sentence.length <= max) return sentence
  const cut = sentence.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, '')}…`
}

export function statusLine(note: { text: string; at: string } | null | undefined): StatusLine | null {
  if (!note?.text?.trim()) return null
  const handoff = parseHandoff(note.text)
  if (handoff?.result) {
    return { now: firstSentence(handoff.result), next: handoff.next ? firstSentence(handoff.next) : null, at: note.at }
  }
  // A plain note: its first line of prose, headings and list marks left out.
  const prose = note.text.split('\n').filter((l) => !/^\s*#{1,6}\s/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean).join(' ')
  return prose ? { now: firstSentence(prose), next: null, at: note.at } : null
}
