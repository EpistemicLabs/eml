// Time in the cockpit's code: one day, and the --duration-* tokens of index.css in milliseconds for
// the timers that belong to something on screen (a slide that must finish, how long a toast stays).

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A --duration-* token in milliseconds, as the document resolves it; 0 where it is not set. */
export function durationMs(token: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (!value) return 0;
  const n = Number.parseFloat(value);
  return value.endsWith('ms') ? n : n * 1000;
}

/** "5 min ago", "3 h ago", "2 days ago". */
export function formatAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / (24 * 60))} days ago`;
}
