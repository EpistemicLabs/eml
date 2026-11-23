/** A title a person or a session gave as a task's kebab-case anchor; null when nothing usable is left. */
export function kebabTitle(title: string): string | null {
  const kebab = title
    .replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '')
  return kebab.length >= 3 ? kebab : null
}
