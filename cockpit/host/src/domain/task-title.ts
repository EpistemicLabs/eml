/** A title a person or a session gave as a task's kebab-case anchor; null when nothing usable is left. */
export function kebabTitle(title: string): string | null {
  const kebab = title
    .replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '')
  return kebab.length >= 3 ? kebab : null
}

/** The longest display title the brain takes (packages/core fields.ts). */
export const DISPLAY_TITLE_MAX = 80

/**
 * A title a person or a session gave, as a task's display_title: the words as written, on one line,
 * cut at a word when longer than the brain takes; null when nothing readable is left or it is only a
 * kebab anchor (then the cockpit shows the anchor as words anyway).
 */
export function displayTitleOf(title: string): string | null {
  const flat = title.replace(/\s+/g, ' ').trim()
  if (flat.length < 3 || /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(flat)) return null
  if (flat.length <= DISPLAY_TITLE_MAX) return flat
  const cut = flat.slice(0, DISPLAY_TITLE_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > DISPLAY_TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, '')}…`
}

/** The name the cockpit gives a session's task before anyone names it (application/session-task.ts placeholderTitle). */
export const PLACEHOLDER_TITLE = /^session-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/

/**
 * The name a person reads for a task, as the tasks card shows it: its display_title, else its kebab anchor as
 * words. Null while it still has the cockpit's placeholder: that is no name yet.
 */
export function taskNameOf(task: { title: string | null; displayTitle?: string | null }): string | null {
  if (task.displayTitle) return task.displayTitle
  if (!task.title || PLACEHOLDER_TITLE.test(task.title)) return null
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(task.title)) return task.title
  const words = task.title.split(/[-_]/).join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
