import type { EventStore, RuntimeEvent, StoredEvent } from '../domain/session-runtime.js'

// A very long session must not grow the host without bound. Streamed deltas are
// dropped once their block is final, so this counts mostly whole messages.
const MAX_EVENTS_PER_SESSION = 20_000

interface SessionLog {
  epoch: number
  nextSeq: number
  events: StoredEvent[]
}

/** The first EventStore: a buffer per session, gone with the host (history then comes from the transcript). */
export class InMemoryEventStore implements EventStore {
  private logs = new Map<string, SessionLog>()
  private nextEpoch = 1

  private log(sessionId: string): SessionLog {
    let log = this.logs.get(sessionId)
    if (!log) {
      log = { epoch: this.nextEpoch++, nextSeq: 1, events: [] }
      this.logs.set(sessionId, log)
    }
    return log
  }

  append(sessionId: string, event: RuntimeEvent): StoredEvent {
    const log = this.log(sessionId)
    // A client that already has the deltas gets the final text as well, and one
    // that comes later needs only that.
    if (event.kind === 'text' || event.kind === 'thinking') {
      const delta = event.kind === 'text' ? 'text_delta' : 'thinking_delta'
      log.events = log.events.filter(({ event: e }) => !(e.kind === delta && e.blockId === event.blockId))
    }
    const stored = { seq: log.nextSeq++, event }
    log.events.push(stored)
    if (log.events.length > MAX_EVENTS_PER_SESSION) log.events.splice(0, log.events.length - MAX_EVENTS_PER_SESSION)
    return stored
  }

  after(sessionId: string, seq: number): StoredEvent[] {
    return this.log(sessionId).events.filter((stored) => stored.seq > seq)
  }

  reset(sessionId: string): number {
    this.logs.delete(sessionId)
    return this.log(sessionId).epoch
  }

  epoch(sessionId: string): number {
    return this.log(sessionId).epoch
  }

  forget(sessionId: string): void {
    this.logs.delete(sessionId)
  }
}
