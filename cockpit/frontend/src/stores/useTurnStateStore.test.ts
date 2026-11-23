// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectTurnEvents } from './useTurnStateStore';

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
