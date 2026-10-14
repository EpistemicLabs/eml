// POSIX-only path helpers for the project wizard. Pure string functions:
// nothing here touches the network or the filesystem.

const lastSlashIndex = (text: string) => text.lastIndexOf('/');

/**
 * The directory whose children are offered as suggestions for what the user
 * typed: the parent of the typed path. `/Users/me/pro` → `/Users/me`,
 * `/Us` → `/`, `~/pro` → `~`, and text without a slash → `~`.
 */
export function suggestionRootOf(typed: string): string {
  const trimmed = typed.trim();
  const slash = lastSlashIndex(trimmed);
  if (slash < 0) return '~';
  if (slash === 0) return '/';
  return trimmed.slice(0, slash);
}

/**
 * The part of the typed path after its last slash (the whole text when there
 * is none). This is what a suggestion's folder name is matched against.
 */
export function lastSegmentOf(typed: string): string {
  const trimmed = typed.trim();
  const slash = lastSlashIndex(trimmed);
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * The parent the folder browser can navigate up to, or `null` when there is
 * none (`~` and `/`). `/Users` → `/`, `/Users/me` → `/Users`, `abc` → `/`.
 */
export function parentPathOf(current: string): string | null {
  if (current === '~' || current === '/') return null;
  const slash = lastSlashIndex(current);
  if (slash <= 0) return '/';
  return current.slice(0, slash);
}

/**
 * Join a base directory with a folder name: trailing slashes on the base and
 * surrounding whitespace on both are dropped. `/` + `new` → `/new`,
 * `~` + `new` → `~/new`, `/a//` + ` b ` → `/a/b`.
 */
export function joinPath(base: string, name: string): string {
  const cleanBase = base.trim().replace(/\/+$/, '');
  return `${cleanBase}/${name.trim()}`;
}
