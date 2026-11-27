import { HANDOFF_LABELS as L, readAskLine, readCheckLine, readNextLine, type Ask, type Check } from './turn-end.js'

/**
 * The handoff block: how a session without the end_turn tool (a terminal, an
 * older session) says where its task stands when it stops, at the end of its
 * last message. domain/turn-end.ts asks for it, and writes the same block from
 * an end_turn call for the task's journal.
 *
 *   ### Handoff
 *   Result: …
 *   Failed: …
 *   Checked: … · Claimed: …
 *   Decided: …
 *   Ask: [who] … · do · due YYYY-MM-DD
 *   Check: YYYY-MM-DDTHH:MM · …   (or: none)
 *   Questions:
 *   - [owner] …
 *   - [task] …
 *
 * Read leniently: any heading level, the block inside a code fence or not,
 * labels in any case, lines left out. A question without a tag is the user's;
 * one tagged [task] is from before end_turn and stays in the journal only. A block
 * of a session started on an older version has "Next: [who] … @ when" instead of Ask and
 * Check; it is still read (domain/turn-end.ts askAndCheckOf).
 * The labels and the shape of the Next line are turn-end.ts's.
 */

export interface Handoff {
  /** The block as written, without the fence: what goes into the task's history. */
  text: string
  result: string | null
  /** The Next line as written. */
  next: string | null
  /** The Next line read as "[who] what @ when"; who is null when it has no tag. */
  nextStep?: { who: string | null; what: string; when: string | null } | null
  /** The Ask line: whose move it is; null without one (or one without a [who]). */
  ask?: Ask | null
  /** The Check line: when the agent looks again, or "none"; null without one. */
  check?: Check | 'none' | null
  failed?: string | null
  checked?: string | null
  claimed?: string | null
  decided?: string | null
  /** Questions only the user can answer. */
  forUser: string[]
  /** Open questions for the task. */
  forTask: string[]
}

const HEADING = new RegExp(`^[ \\t]*#{1,6}[ \\t]*${L.heading}[ \\t]*:?[ \\t]*$`, 'gim')
const FENCE = /^[ \t]*```[a-z]*[ \t]*$/i

export function parseHandoff(message: string): Handoff | null {
  const headings = [...message.matchAll(HEADING)]
  const last = headings.at(-1)
  if (!last || last.index === undefined) return null
  const lines = message.slice(last.index).split('\n')
  // The block ends at a closing fence or the end of the message.
  const end = lines.findIndex((line, i) => i > 0 && FENCE.test(line))
  const block = (end === -1 ? lines : lines.slice(0, end)).map((l) => l.trimEnd())
  const body = block.slice(1)

  // A label, bold or not, after a bullet or not: "Result:", "- **Result:**", "**Result**:".
  const label = (name: string) => new RegExp(`^\\s*(?:[-*]\\s+)?\\**${name}\\**\\s*:\\**\\s*`, 'i')
  const field = (name: string): string | null => {
    const line = body.find((l) => label(name).test(l))
    const value = line?.replace(label(name), '').trim()
    return value ? value : null
  }

  const forUser: string[] = []
  const forTask: string[] = []
  const start = body.findIndex((l) => label(L.questions).test(l))
  if (start !== -1) {
    const inline = body[start].replace(label(L.questions), '').trim()
    const items = [inline, ...body.slice(start + 1)]
    for (const raw of items) {
      const item = raw.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim()
      if (!item || /^(none|no|—|-)\.?$/i.test(item)) continue
      // The next label ends the list.
      if ([L.result, L.failed, L.checked, L.claimed, L.decided, L.ask, L.check, L.next].some((name) => label(name).test(item))) break
      // A tag is a handle in brackets; a markdown link is not one.
      const tagged = /^\[([^\]\s]+)\](?!\()\s*(.*)$/.exec(item)
      if (tagged && tagged[1].toLowerCase() === 'task') forTask.push(tagged[2].trim())
      else forUser.push((tagged ? tagged[2] : item).trim())
    }
  }

  // "Checked: … · Claimed: …" on one line, or each on its own.
  const [checked, claimedInline] = (field(L.checked) ?? '').split(new RegExp(`\\s*·\\s*${L.claimed}\\s*:\\s*`, 'i'))
  const next = field(L.next)
  const ask = field(L.ask)
  const check = field(L.check)

  return {
    text: block.join('\n').trim(),
    result: field(L.result),
    next,
    nextStep: next ? readNextLine(next) : null,
    ask: ask ? readAskLine(ask) : null,
    check: check ? readCheckLine(check) : null,
    failed: field(L.failed),
    checked: checked?.trim() || null,
    claimed: claimedInline?.trim() || field(L.claimed),
    decided: field(L.decided),
    forUser: forUser.filter(Boolean),
    forTask: forTask.filter(Boolean),
  }
}
