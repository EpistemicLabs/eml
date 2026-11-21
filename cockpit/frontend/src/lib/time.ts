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
