import * as fs from 'node:fs'

/** How much of a transcript's end is read for the last reply. */
const TAIL_BYTES = 512 * 1024

/**
 * The last assistant text in a Claude Code transcript (JSONL), read from its
 * end: what a Stop hook's transcript_path names when its payload carries no
 * last_assistant_message. Empty when the file is not one or has none.
 */
export function lastReplyInTranscript(file: unknown): string {
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return ''
  let tail: string
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const length = Math.min(size, TAIL_BYTES)
      const buf = Buffer.alloc(length)
      fs.readSync(fd, buf, 0, length, size - length)
      tail = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
  for (const line of tail.split('\n').reverse()) {
    if (!line.includes('"assistant"')) continue
    try {
      const record = JSON.parse(line) as { type?: string; message?: { content?: unknown } }
      if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) continue
      const text = (record.message.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
      if (text.trim()) return text
    } catch { /* a line cut off at the start of the tail */ }
  }
  return ''
}
