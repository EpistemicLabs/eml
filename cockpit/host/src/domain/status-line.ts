import { parseHandoff } from './handoff.js'

/**
 * Where a task stands, in one line, from its newest journal note: the first sentence of the
 * newest handoff's Result (and its Next for the task view), or else the note's first sentence.
 * The journal gets a handoff whenever a session's stop changes where the task stands
 * (domain/turn-end.ts); nothing else stores the line.
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

/** A who as people read it: a handle with a capital, someone outside by their name. */
function readableWho(who: string): string {
  const name = who.replace(/^outside:\s*/i, '').trim()
  return name ? `${name[0].toUpperCase()}${name.slice(1)}` : ''
}

/** The next step as the task view shows it: "Kim: review the PR". The time is left out; a Next without a who is its text. */
function nextLine(step: { who: string | null; what: string; when: string | null } | null | undefined): string | null {
  if (!step) return null
  const who = step.who ? readableWho(step.who) : ''
  const what = step.what ? firstSentence(step.what) : ''
  return [who, what].filter(Boolean).join(': ') || null
}

export function statusLine(note: { text: string; at: string } | null | undefined): StatusLine | null {
  if (!note?.text?.trim()) return null
  const handoff = parseHandoff(note.text)
  if (handoff?.result) {
    return { now: firstSentence(handoff.result), next: nextLine(handoff.nextStep), at: note.at }
  }
  // A plain note: its first line of prose, headings and list marks left out.
  const prose = note.text.split('\n').filter((l) => !/^\s*#{1,6}\s/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean).join(' ')
  return prose ? { now: firstSentence(prose), next: null, at: note.at } : null
}
