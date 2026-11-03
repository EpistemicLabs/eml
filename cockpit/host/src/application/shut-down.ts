/**
 * Host shutdown. Chat sessions get to end their turn and close their processes, so a
 * fast restart can't resume a conversation the old process is still in. Bounded: a stuck
 * process must not hold up the restart. The service managers allow more (systemd 90 s,
 * launchd 20 s). A second signal exits at once.
 */
export const SHUTDOWN_TIMEOUT_MS = 15_000

export interface ShutDownDeps {
  /** Stop taking work: sockets, timers, terminals. */
  stop(): void
  /** End the chat sessions; resolves once their processes are gone. */
  drain(): Promise<void>
  /** What may only go once the sessions are gone (the brain server they write to). */
  last(): void
  exit(code: number): void
  log(line: string): void
}

export function shutDownOnSignal(deps: ShutDownDeps, timeoutMs = SHUTDOWN_TIMEOUT_MS): () => Promise<void> {
  let started = false
  return async () => {
    if (started) { deps.exit(0); return }
    started = true
    try { deps.stop() } catch { /* best-effort */ }
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs) })
    const drained = deps.drain().then(() => false, () => false)
    if (await Promise.race([drained, timedOut])) deps.log(`shutdown: sessions still closing after ${timeoutMs / 1000}s, exiting anyway`)
    clearTimeout(timer)
    try { deps.last() } catch { /* best-effort */ }
    deps.exit(0)
  }
}
