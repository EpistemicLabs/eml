/**
 * The handoff a session ends with in a task-system space (application/session-task.ts
 * asks for it): a "### Handoff" block at the end of its last message.
 *
 *   ### Handoff
 *   Result: …
 *   Checked: … · Claimed: …
 *   Decided: …
 *   Next: …
 *   Questions:
 *   - [lasse] …
 *   - [task] …
 *
 * Read leniently: any heading level, the block inside a code fence or not,
 * labels in any case, lines left out. A question without a tag is the user's.
 */

export interface Handoff {
  /** The block as written, without the fence: what goes into the task's history. */
  text: string
  result: string | null
  next: string | null
  /** Questions only the user can answer. */
  forUser: string[]
  /** Open questions for the task. */
  forTask: string[]
}

const HEADING = /^[ \t]*#{1,6}[ \t]*Handoff[ \t]*:?[ \t]*$/gim
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
  const start = body.findIndex((l) => label('Questions').test(l))
  if (start !== -1) {
    const inline = body[start].replace(label('Questions'), '').trim()
    const items = [inline, ...body.slice(start + 1)]
    for (const raw of items) {
      const item = raw.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim()
      if (!item || /^(none|no|—|-)\.?$/i.test(item)) continue
      // The next label ends the list.
      if (['Result', 'Checked', 'Decided', 'Next'].some((name) => label(name).test(item))) break
      const tagged = /^\[(\w+)\]\s*(.*)$/.exec(item)
      if (tagged && tagged[1].toLowerCase() === 'task') forTask.push(tagged[2].trim())
      else forUser.push((tagged ? tagged[2] : item).trim())
    }
  }

  return {
    text: block.join('\n').trim(),
    result: field('Result'),
    next: field('Next'),
    forUser: forUser.filter(Boolean),
    forTask: forTask.filter(Boolean),
  }
}
