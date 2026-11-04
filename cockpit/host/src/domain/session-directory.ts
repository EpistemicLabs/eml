/**
 * The sessions a session can message, as an agent reads them: to turn what its
 * user calls a session ("the catalogue session") into an address. Claude Code's
 * ListAgents shows running sessions only, and by address; this adds the stopped
 * ones and what each is about. Pure, so the rules can be read and tested alone.
 */

export type DirectoryState = 'running' | 'stopped' | 'archived'

export interface DirectoryEntry {
  address: string
  /** The name the sidebar shows. */
  name: string
  /** The last status reason the session gave: what came of it. */
  outcome: string | null
  /** The first line of its first prompt: what it was asked. */
  asked: string | null
  project: string | null
  state: DirectoryState
  lastActive: string
  /** The address of the session that started it. */
  parent: string | null
  /** Pinned or a desk's main pane: the sessions the user keeps coming back to. */
  main: boolean
}

export interface DirectoryQuery {
  /** Every word has to occur in the name, the outcome, the request or the project. */
  words: string[]
  state?: Exclude<DirectoryState, 'archived'>
  /** Words of the project name. */
  project?: string
  archived?: boolean
  limit?: number
}

export const SEARCH_LIMIT = 10
/**
 * Claude Code caps a hook's added context at 10,000 characters and turns a
 * longer one into a file path and a short preview (hooks reference, "Output
 * limits"). ListAgents' list fills up to just under that.
 */
export const LIST_BUDGET = 9_500

const normalise = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')

const byRecency = (a: DirectoryEntry, b: DirectoryEntry): number => b.lastActive.localeCompare(a.lastActive)

/** The sessions that fit, best first: more words in the name, then the most recent. */
export function searchSessions(entries: DirectoryEntry[], query: DirectoryQuery): DirectoryEntry[] {
  const words = query.words.map(normalise).filter(Boolean)
  const project = query.project ? normalise(query.project).split(/\s+/).filter(Boolean) : []
  return entries
    .filter((entry) => (query.archived ? true : entry.state !== 'archived'))
    .filter((entry) => !query.state || entry.state === query.state)
    .filter((entry) => project.every((word) => normalise(entry.project ?? '').includes(word)))
    .map((entry) => {
      const name = normalise(entry.name)
      const all = normalise([entry.name, entry.outcome, entry.asked, entry.project, entry.address].filter(Boolean).join(' '))
      return { entry, fits: words.every((word) => all.includes(word)), inName: words.filter((word) => name.includes(word)).length }
    })
    .filter(({ fits }) => fits)
    .sort((a, b) => b.inName - a.inName || byRecency(a.entry, b.entry))
    .slice(0, query.limit ?? SEARCH_LIMIT)
    .map(({ entry }) => entry)
}

/** The order of the list after ListAgents: the user's main sessions first however old, then the most recent. */
export function recentSessions(entries: DirectoryEntry[]): DirectoryEntry[] {
  const open = entries.filter((entry) => entry.state !== 'archived').sort(byRecency)
  return [...open.filter((entry) => entry.main), ...open.filter((entry) => !entry.main)]
}

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * When, as a date and time: the hook's text is replayed when a session resumes,
 * so "3h ago" would turn wrong. In the host's time zone, like the sidebar.
 */
export function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '?'
  const month = date.toLocaleString('en-US', { month: 'short' })
  return `${month} ${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const head = (entry: DirectoryEntry, nameMax: number, projectMax: number): string => [
  entry.address,
  entry.state,
  when(entry.lastActive),
  entry.project && oneLine(entry.project, projectMax),
  `"${oneLine(entry.name || '(no name)', nameMax)}"`,
].filter(Boolean).join(' · ')

/** One line of at most about 160 characters: what it came to, else what it was asked. For the list after ListAgents. */
export function formatShort(entry: DirectoryEntry): string {
  const about = entry.outcome ? `last: ${oneLine(entry.outcome, 45)}` : entry.asked && entry.asked !== entry.name ? `asked: ${oneLine(entry.asked, 45)}` : null
  return [head(entry, 40, 20), about].filter(Boolean).join(' — ')
}

/** Two lines for a search result: what it was asked and what it came to. */
export function formatEntry(entry: DirectoryEntry): string {
  const about = [
    entry.asked && entry.asked !== entry.name ? `asked: ${oneLine(entry.asked, 100)}` : null,
    entry.outcome ? `last: ${oneLine(entry.outcome, 100)}` : null,
  ].filter(Boolean).join(' | ')
  return about ? `${head(entry, 80, 40)}\n  ${about}` : head(entry, 80, 40)
}

const SEARCH = 'node "$COCKPIT_SESSIONS_JS"'

const PICK_RULE = 'If more than one could be the one your user means, ask them to pick from a numbered list (address, name, last active) before sending: a message to the wrong session wakes it and hands it your text.'

/** What ListAgents adds to its own result (list-agents-hook.ts): as many sessions as fit under the cap. */
export function listAgentsContext(entries: DirectoryEntry[], budget: number = LIST_BUDGET): string {
  const ordered = recentSessions(entries)
  const lines: string[] = []
  // The header's own length, with the counts at their widest.
  let used = header(ordered.length, ordered.length).length
  for (const entry of ordered) {
    const line = formatShort(entry)
    if (used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
  }
  return [header(lines.length, ordered.length), ...lines].join('\n')
}

function header(shown: number, total: number): string {
  return [
    `Showing ${shown} of ${total} cockpit sessions you can message: pinned and main ones, then the most recent. Stopped ones work too: SendMessage to the address wakes one. Not listed? Search all of them by name and description: ${SEARCH} <words from what your user called it>`,
    PICK_RULE,
    '',
  ].join('\n')
}

/** What the search command prints. */
export function searchResult(found: DirectoryEntry[], query: DirectoryQuery): string {
  if (found.length === 0) {
    return [
      `No session matches "${query.words.join(' ')}". Retry with other words from what your user called it: ${SEARCH} <other words>.`,
      `Archived sessions: ${SEARCH} <words> --archived. The most recent sessions: ListAgents.`,
    ].join(' ')
  }
  return [
    found.length === 1 ? 'One session fits:' : `${found.length} sessions fit, ranked by how well the name matches, then most recent. ${PICK_RULE}`,
    '',
    ...found.map((entry) => formatEntry(entry)),
  ].join('\n')
}
