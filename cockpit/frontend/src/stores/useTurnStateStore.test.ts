// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectTurnEvents, getTurnSnapshot } from './useTurnStateStore';

/** An EventSource the test drives: it records the listeners and lets the test send events. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();
  constructor(readonly url: string) { FakeEventSource.last = this; }
  addEventListener(type: string, listener: (message: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener() {}
  close() {}
  send(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('the turn event stream', () => {
  it('reloads the task board on every (re)connect, since a change may have gone by while it was down', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const reloads: Event[] = [];
    const onTasks = (event: Event) => { reloads.push(event); };
    window.addEventListener('cockpit:tasks', onTasks);
    const disconnect = connectTurnEvents();
    FakeEventSource.last!.send('snapshot', []);
    FakeEventSource.last!.send('snapshot', []);
    expect(reloads).toHaveLength(2);
    disconnect();
    window.removeEventListener('cockpit:tasks', onTasks);
  });

  it('keeps how many subagents a working session waits for, from the snapshot and from each change', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const disconnect = connectTurnEvents();
    const since = '2026-02-01T11:00:00.000Z';
    FakeEventSource.last!.send('snapshot', [{ sessionId: 'a', state: 'working', since, helpers: 2 }, { sessionId: 'b', state: 'working', since }]);
    expect(getTurnSnapshot().turns).toEqual({ a: { state: 'working', since, helpers: 2 }, b: { state: 'working', since } });
    FakeEventSource.last!.send('turn', { sessionId: 'a', state: 'working', since, helpers: 1 });
    expect(getTurnSnapshot().turns.a).toEqual({ state: 'working', since, helpers: 1 });
    FakeEventSource.last!.send('turn', { sessionId: 'a', state: 'working', since });
    expect(getTurnSnapshot().turns.a).toEqual({ state: 'working', since });
    disconnect();
  });

  it('keeps the workflow runs a working session waits for, and drops them once there are none', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const disconnect = connectTurnEvents();
    const since = '2026-02-01T11:00:00.000Z';
    const review = { name: 'review-changes', running: 3, done: 4 };
    FakeEventSource.last!.send('snapshot', [{ sessionId: 'a', state: 'working', since, workflows: [review] }]);
    expect(getTurnSnapshot().turns.a).toEqual({ state: 'working', since, workflows: [review] });
    FakeEventSource.last!.send('turn', { sessionId: 'a', state: 'working', since, helpers: 1, workflows: [review] });
    expect(getTurnSnapshot().turns.a).toEqual({ state: 'working', since, helpers: 1, workflows: [review] });
    FakeEventSource.last!.send('turn', { sessionId: 'a', state: 'working', since, workflows: [] });
    expect(getTurnSnapshot().turns.a).toEqual({ state: 'working', since });
    disconnect();
  });

  it('passes a tasks event on to the board', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const seen: unknown[] = [];
    const onTasks = (event: Event) => { seen.push((event as CustomEvent).detail); };
    window.addEventListener('cockpit:tasks', onTasks);
    const disconnect = connectTurnEvents();
    FakeEventSource.last!.send('tasks', { changes: [] });
    expect(seen).toEqual([{ changes: [] }]);
    disconnect();
    window.removeEventListener('cockpit:tasks', onTasks);
  });
});
