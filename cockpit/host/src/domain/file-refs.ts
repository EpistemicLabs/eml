/**
 * Files an agent names in its replies (the media viewer): the paths in a message's text that point at
 * a file the cockpit can show. Pure text work; whether a path exists is the caller's question.
 * The frontend has the same rules (components/media/file-refs.ts): a chip in a chat and a file in
 * ⌘K come from the same reading of the text.
 */

/** What a file shows as, by its extension. */
export type FileKind = 'csv' | 'image' | 'pdf' | 'markdown'

const KIND_BY_EXT: Record<string, FileKind> = {
  csv: 'csv', tsv: 'csv',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  pdf: 'pdf',
  md: 'markdown', markdown: 'markdown',
}

export const MEDIA_TYPE_BY_EXT: Record<string, string> = {
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
}

export function extensionOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function fileKind(file: string): FileKind | null {
  return KIND_BY_EXT[extensionOf(file)] ?? null
}

const EXT = Object.keys(KIND_BY_EXT).join('|')
// A path without spaces: absolute, from home (~/), or relative (dir/file.ext, ./file.ext, file.ext).
// It starts after the text's start, a space or an opening mark, so a URL's path (https://x/a.png)
// never matches: its slashes follow ':' or '/'.
const BARE = new RegExp(`(?:^|[\\s(\\[<"'*])((?:~\\/|\\.{1,2}\\/|\\/)?[\\w@%+=.,-][\\w@%+=.,~\\/-]*\\.(?:${EXT}))(?=$|[\\s)\\]>"'*:;,!?]|\\.(?:\\s|$))`, 'gim')
// Inside backticks or a markdown link target a path may hold spaces.
const QUOTED = new RegExp(`\`([^\`\\n]+\\.(?:${EXT}))\`|\\]\\(<?([^)<>\\n]+\\.(?:${EXT}))>?\\)`, 'gi')

/** The file paths in a text, in the order they first appear, each once. */
export function extractFileRefs(text: string): string[] {
  const found: Array<{ at: number; ref: string }> = []
  const quoted: Array<[number, number]> = []
  for (const match of text.matchAll(QUOTED)) {
    const at = match.index ?? 0
    quoted.push([at, at + match[0].length])
    const ref = (match[1] ?? match[2] ?? '').trim()
    if (ref && !/^[a-z][a-z0-9+.-]*:/i.test(ref)) found.push({ at, ref })
  }
  for (const match of text.matchAll(BARE)) {
    const ref = match[1]
    if (!ref || ref.includes('//')) continue
    const at = (match.index ?? 0) + match[0].indexOf(ref)
    // A piece of a quoted path (after its space) is not a path of its own.
    if (quoted.some(([from, to]) => at >= from && at < to)) continue
    found.push({ at, ref })
  }
  found.sort((a, b) => a.at - b.at)
  const seen = new Set<string>()
  const refs: string[] = []
  for (const { ref } of found) {
    if (seen.has(ref)) continue
    seen.add(ref)
    refs.push(ref)
  }
  return refs
}
