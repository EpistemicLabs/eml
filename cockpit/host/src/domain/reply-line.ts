/**
 * The line that says what an agent's answer is about, for a list row: the
 * first line of the reply that reads as text. Headings, rules, code fences
 * and lines that are only a bold label are skipped; list markers, quote
 * marks and inline emphasis are dropped. Null when nothing reads as text.
 */

const REPLY_LINE_MAX = 200

const SKIP = [
  /^#{1,6}\s/, // heading
  /^(-{3,}|\*{3,}|_{3,})$/, // rule
  /^\*\*[^*]+\*\*:?$/, // a bold label on its own
  /^\|/, // table row
]

export function replyLine(text: string): string | null {
  let inFence = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence || !line || SKIP.some((re) => re.test(line))) continue
    const plain = line
      .replace(/^(>\s*)+/, '')
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (!plain) continue
    return plain.length > REPLY_LINE_MAX ? `${plain.slice(0, REPLY_LINE_MAX - 1)}…` : plain
  }
  return null
}
