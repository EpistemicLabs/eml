/** A run this long counts as having held: the next crash starts the count again. */
export const STEADY_MS = 10 * 60_000

const FIRST_MS = 1_000
const MAX_MS = 60_000

/** How long to wait before starting a crashed child again, after this many crashes in a row. */
export function restartDelay(failures: number): number {
  return Math.min(FIRST_MS * 2 ** Math.max(failures - 1, 0), MAX_MS)
}

/** The crashes in a row after one more exit, given how long the run lasted. */
export function failuresAfterExit(previous: number, ranMs: number): number {
  return ranMs >= STEADY_MS ? 1 : previous + 1
}
