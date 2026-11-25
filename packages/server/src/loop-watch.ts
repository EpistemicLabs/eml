// --- The blocked request thread ---------------------------------------------------------
//
// The server answers every brain from one thread. A handler that computes for
// seconds answers nobody else for that long, and nothing says so: the callers
// only see timeouts. This watch measures it — a timer that should fire every
// TICK_MS and fires late was held up by exactly that much — and names the
// request that ran last, which is the one that held the thread (a handler runs
// alone until it awaits). One line per block, never a query, a name or content:
// the method, the path and the brain's id.

/** How often the watch looks. */
export const LOOP_TICK_MS = 250
/** A block shorter than this is not worth a line. */
export const LOOP_BLOCKED_MS = 1000

export interface LoopWatch {
  /** A handler starts (or goes on after it read its body): the request a block from now on belongs to. */
  enter(label: string): void
  stop(): void
}

export interface LoopWatchOptions {
  log: (line: string) => void
  now?: () => number
  /** The timer; tests pass their own and call the tick themselves. */
  every?: (tick: () => void, ms: number) => () => void
}

/** The line for a block of `ms`, with the request that ran last. */
export function blockedLine(ms: number, label: string | null): string {
  return `[loop] the request thread was blocked for ${Math.round(ms)} ms${label ? ` (last request: ${label})` : ''}`
}

/** What a request is called in the log: its method and path, without the query, and its brain's id. */
export function requestLabel(method: string | undefined, url: string, brainId?: string): string {
  return `${method ?? 'GET'} ${url.split('?')[0]}${brainId ? ` · ${brainId}` : ''}`
}

export function watchLoop(opts: LoopWatchOptions): LoopWatch {
  const now = opts.now ?? (() => performance.now())
  const every = opts.every ?? ((tick, ms) => {
    const timer = setInterval(tick, ms)
    timer.unref?.()
    return () => clearInterval(timer)
  })
  let last: string | null = null
  let expected = now() + LOOP_TICK_MS
  const stop = every(() => {
    const at = now()
    const late = at - expected
    if (late >= LOOP_BLOCKED_MS) opts.log(blockedLine(late, last))
    expected = at + LOOP_TICK_MS
  }, LOOP_TICK_MS)
  return { enter(label) { last = label }, stop }
}
