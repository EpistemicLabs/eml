// Mirror of the host's domain/file-refs.ts (keep the two in step): which paths in an agent's reply are
// files the media viewer shows. The host checks that they exist (POST /api/files/stat), so a path
// read here that is no file shows nothing.

/** What a file shows as, by its extension. */
export type FileKind = 'csv' | 'image' | 'pdf' | 'markdown';

const KIND_BY_EXT: Record<string, FileKind> = {
  csv: 'csv', tsv: 'csv',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  pdf: 'pdf',
  md: 'markdown', markdown: 'markdown',
};

export function extensionOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function fileKind(file: string): FileKind | null {
  return KIND_BY_EXT[extensionOf(file)] ?? null;
}

const EXT = Object.keys(KIND_BY_EXT).join('|');
// A path without spaces: absolute, from home (~/), or relative (dir/file.ext, ./file.ext, file.ext).
// It starts after the text's start, a space or an opening mark, so a URL's path (https://x/a.png)
// never matches: its slashes follow ':' or '/'.
const BARE = new RegExp(`(?:^|[\\s(\\[<"'*])((?:~\\/|\\.{1,2}\\/|\\/)?[\\w@%+=.,-][\\w@%+=.,~\\/-]*\\.(?:${EXT}))(?=$|[\\s)\\]>"'*:;,!?]|\\.(?:\\s|$))`, 'gim');
// Inside backticks or a markdown link target a path may hold spaces.
const QUOTED = new RegExp(`\`([^\`\\n]+\\.(?:${EXT}))\`|\\]\\(<?([^)<>\\n]+\\.(?:${EXT}))>?\\)`, 'gi');

/** The file paths in a text, in the order they first appear, each once. */
export function extractFileRefs(text: string): string[] {
  const found: Array<{ at: number; ref: string }> = [];
  const quoted: Array<[number, number]> = [];
  for (const match of text.matchAll(QUOTED)) {
    const at = match.index ?? 0;
    quoted.push([at, at + match[0].length]);
    const ref = (match[1] ?? match[2] ?? '').trim();
    if (ref && !/^[a-z][a-z0-9+.-]*:/i.test(ref)) found.push({ at, ref });
  }
  for (const match of text.matchAll(BARE)) {
    const ref = match[1];
    if (!ref || ref.includes('//')) continue;
    const at = (match.index ?? 0) + match[0].indexOf(ref);
    // A piece of a quoted path (after its space) is not a path of its own.
    if (quoted.some(([from, to]) => at >= from && at < to)) continue;
    found.push({ at, ref });
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const { ref } of found) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

/** The short type label a chip shows (CSV, PNG, PDF, MD). */
export function typeLabel(file: string): string {
  const ext = extensionOf(file);
  return ext === 'markdown' ? 'md' : ext === 'jpeg' ? 'jpg' : ext;
}

/** A size in words: 840 B, 1.2 KB, 2.4 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
