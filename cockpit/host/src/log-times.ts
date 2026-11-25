import { StringDecoder } from 'node:string_decoder'

/**
 * The time before every line the host prints. The host log (host.log: the
 * service's stdout and stderr, or log-file.ts) is what a late view or a failed
 * call is traced back in, and a line without a time cannot be put next to what
 * a person saw on the screen. Everything goes through the two streams — the
 * host's own lines, the brain server's and the bridge's, a library's warning —
 * so the time is added there, once, not in each caller.
 *
 * index.ts calls timeLogLines() when it runs the host; the commands that print
 * for a caller (spawn, schedule, the hooks) keep their output as it is.
 */

/** A line's time in the log: UTC to the second, `2026-11-25T09:00:37Z`. */
export const logTime = (at: Date): string => `${at.toISOString().slice(0, 19)}Z`

/** A line that starts with a log time, and the rest of it. */
const TIMED_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (.*)$/s

/** The line without its time (log lines from before the times have none). */
export function withoutLogTime(line: string): string {
  return TIMED_LINE.exec(line)?.[1] ?? line
}

/**
 * Each text once, as its newest line, in the order they last came: with a time
 * in front, two lines of one message would otherwise count as two.
 */
export function newestOfEach(lines: string[]): string[] {
  const newest = new Map<string, string>()
  for (const line of lines) {
    const text = withoutLogTime(line)
    newest.delete(text)
    newest.set(text, line)
  }
  return [...newest.values()]
}

/**
 * `text` with `time` before every line that begins in it. `atLineStart` says
 * whether the text before ended its line; the answer says the same for the
 * text after. An empty line stays empty.
 */
export function stampLines(text: string, time: string, atLineStart: boolean): { text: string; atLineStart: boolean } {
  if (text === '') return { text, atLineStart }
  let out = ''
  let start = atLineStart
  for (const part of text.split(/(?<=\n)/)) {
    out += start && part !== '\n' && part !== '\r\n' ? `${time} ${part}` : part
    start = part.endsWith('\n')
  }
  return { text: out, atLineStart: start }
}

/** Put the time before every line written to `stream` from now on: text as it comes, bytes decoded first (a character may arrive in two pieces). */
export function timeLines(stream: Pick<NodeJS.WriteStream, 'write'>, now: () => Date): void {
  const write = stream.write.bind(stream) as (chunk: string, encoding?: unknown, cb?: unknown) => boolean
  const decoder = new StringDecoder('utf8')
  let atLineStart = true
  stream.write = ((chunk: string | Uint8Array, encoding?: unknown, cb?: unknown) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk))
    const stamped = stampLines(text, logTime(now()), atLineStart)
    atLineStart = stamped.atLineStart
    // the text is a string now: an encoding given for it no longer applies
    return write(stamped.text, typeof encoding === 'function' ? encoding : cb)
  }) as typeof stream.write
}

/** From here on every line the host prints starts with its time. */
export function timeLogLines(now: () => Date = () => new Date()): void {
  timeLines(process.stdout, now)
  timeLines(process.stderr, now)
}
