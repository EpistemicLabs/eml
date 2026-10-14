/**
 * Just enough TOML writing for Codex's config.toml. Codex owns that file — it
 * stores folder trust, hook trust and UI state there — so the cockpit never
 * rewrites it: it replaces the tables it manages and leaves the rest as is.
 */

/** A TOML basic string. */
export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`
}

export interface TomlTable {
  /** The table name as written between the brackets, e.g. `mcp_servers.eml_brain.env`. */
  header: string
  /** `key = value` lines, already TOML. */
  lines: string[]
}

const HEADER = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(#.*)?$/

const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

/**
 * The parts of a dotted table key, with quotes and escapes resolved — so that
 * `projects."/a b"`, `projects.'/a b'` and `projects . "/a b"` name one table.
 * Codex writes paths with its own quoting, and a duplicate table breaks the
 * file. Null for a key this parser cannot read.
 */
export function tableKey(header: string): string[] | null {
  const parts: string[] = []
  let i = 0
  const text = header.trim()
  while (i < text.length) {
    while (text[i] === ' ' || text[i] === '\t') i++
    let part = ''
    if (text[i] === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] !== '\\') { part += text[i]; continue }
        const next = text[++i]
        if (next === 'u' || next === 'U') {
          const width = next === 'u' ? 4 : 8
          part += String.fromCodePoint(parseInt(text.slice(i + 1, i + 1 + width), 16))
          i += width
        } else if (next in ESCAPES) {
          part += ESCAPES[next]
        } else {
          return null
        }
      }
      if (text[i] !== '"') return null
      i++
    } else if (text[i] === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) return null
      part = text.slice(i + 1, end)
      i = end + 1
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i))
      if (!match) return null
      part = match[0]
      i += part.length
    }
    parts.push(part)
    while (text[i] === ' ' || text[i] === '\t') i++
    if (i < text.length) {
      if (text[i] !== '.') return null
      i++
    }
  }
  return parts.length ? parts : null
}

const sameKey = (a: string, b: string): boolean => {
  const ka = tableKey(a)
  const kb = tableKey(b)
  return ka !== null && kb !== null && ka.length === kb.length && ka.every((part, i) => part === kb[i])
}

/** Whether the document has a table with this name (however it is quoted there). */
export function hasTable(text: string, header: string): boolean {
  return text.split('\n').some((line) => {
    const found = HEADER.exec(line)?.[1]
    return found !== undefined && sameKey(found, header)
  })
}

/** The document without the lines of the tables named in `headers`. */
function dropTables(text: string, headers: string[]): string[] {
  const kept: string[] = []
  let dropping = false
  for (const line of text.split('\n')) {
    const header = HEADER.exec(line)?.[1]
    if (header !== undefined) dropping = headers.some((h) => sameKey(h, header))
    if (!dropping) kept.push(line)
  }
  return kept
}

/** The document with each given table replaced, or appended when it is new. */
export function upsertTables(text: string, tables: TomlTable[]): string {
  const body = dropTables(text, tables.map((table) => table.header)).join('\n').trimEnd()
  const added = tables.map((table) => [`[${table.header}]`, ...table.lines].join('\n')).join('\n\n')
  return `${body ? `${body}\n\n` : ''}${added}\n`
}

/** The document without the given tables; one that is absent stays absent. */
export function removeTables(text: string, headers: string[]): string {
  const body = dropTables(text, headers).join('\n').trimEnd()
  return body ? `${body}\n` : ''
}

/** The document with a top-level `key = value` set (before the first table, where TOML wants it). */
export function setTopLevelKey(text: string, key: string, value: string): string {
  const lines = text.split('\n')
  const firstTable = lines.findIndex((line) => HEADER.test(line))
  const top = firstTable < 0 ? lines : lines.slice(0, firstTable)
  const rest = firstTable < 0 ? [] : lines.slice(firstTable)
  const assignment = `${key} = ${value}`
  const at = top.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line))
  if (at >= 0) top[at] = assignment
  else top.unshift(assignment)
  // One blank line between the top-level keys and the first table.
  while (top.length > 0 && top[top.length - 1].trim() === '') top.pop()
  return [...top, ...(rest.length ? ['', ...rest] : [''])].join('\n')
}
