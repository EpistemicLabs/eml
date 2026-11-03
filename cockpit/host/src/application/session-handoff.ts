import type { SessionRuntimeKind } from '../domain/session-runtime.js'

/** One way of running sessions, as the handoff sees it. */
export interface HandoffSide {
  isRunning(sessionId: string): boolean
  /** Ends the session's process here; resolves once it has exited. */
  end(sessionId: string): Promise<void>
}

/**
 * One writer per conversation, across the terminal and the chat view. Two
 * processes on one session interleave into one transcript and nothing in the
 * agent CLI stops them, so a session enters a side only through here: the other
 * side's process is gone first, and entries of one session run one after another.
 */
export class SessionHandoff {
  private queues = new Map<string, Promise<unknown>>()

  constructor(private sides: Record<SessionRuntimeKind, HandoffSide>) {}

  /** Whether a switch is under way for this session. */
  switching(sessionId: string): boolean {
    return this.queues.has(sessionId)
  }

  /**
   * Run `start` as the session's only writer on `side`. With nothing to end and
   * nothing queued it runs right away, so a plain terminal attach takes no extra
   * turn of the event loop.
   */
  enter(side: SessionRuntimeKind, sessionId: string, start: () => void | Promise<void>): Promise<void> {
    const other = this.sides[side === 'sdk' ? 'terminal' : 'sdk']
    const queued = this.queues.get(sessionId)
    if (!queued && !other.isRunning(sessionId)) {
      const started = start()
      if (!started) return Promise.resolve()
      return this.track(sessionId, started)
    }
    const run = (queued ?? Promise.resolve()).catch(() => { /* the earlier entry reported its own failure */ }).then(async () => {
      if (other.isRunning(sessionId)) await other.end(sessionId)
      await start()
    })
    return this.track(sessionId, run)
  }

  private track(sessionId: string, run: Promise<void>): Promise<void> {
    this.queues.set(sessionId, run)
    const clear = () => { if (this.queues.get(sessionId) === run) this.queues.delete(sessionId) }
    run.then(clear, clear)
    return run
  }
}
