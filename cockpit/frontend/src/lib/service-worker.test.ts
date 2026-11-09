import { describe, expect, it, vi } from 'vitest';

import SOURCE from '../../public/sw.js?raw';

// public/sw.js run against a fake worker scope: every push shows a notification
// (Safari drops a subscription that shows none), and a tap opens its session.

const ORIGIN = 'https://cockpit.example';

type Handler = (event: Record<string, unknown>) => void;
type Client = { url: string; postMessage: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };

function loadWorker(windows: Client[] = []) {
  const handlers: Record<string, Handler> = {};
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => { handlers[type] = handler; },
    skipWaiting: vi.fn(),
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); } },
    clients: { claim: vi.fn(async () => undefined), matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null) },
  };
  new Function('self', SOURCE)(self);
  /** Runs one event and waits for what it handed to waitUntil. */
  const fire = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    handlers[type]({ ...event, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  };
  return { fire, shown, self };
}

const pushOf = (data: unknown) => ({ data: { json: () => (typeof data === 'string' ? JSON.parse(data) : data) } });
const client = (url: string): Client => ({ url, postMessage: vi.fn(), focus: vi.fn(async () => undefined) });
const tap = (navigate: string) => ({ notification: { close: vi.fn(), data: { navigate } } });

describe('service worker', () => {
  it('shows the host\'s notification with the session to open', async () => {
    const { fire, shown } = loadWorker();
    await fire('push', pushOf({ web_push: 8030, notification: { title: 'Needs you · Plan (eml)', body: 'Which one?', tag: 'session:s1', navigate: `${ORIGIN}/?session=s1` } }));
    expect(shown).toEqual([{ title: 'Needs you · Plan (eml)', options: { body: 'Which one?', tag: 'session:s1', icon: '/icon-192.png', data: { navigate: `${ORIGIN}/?session=s1` } } }]);
  });

  it('still shows a notification for a message it cannot read', async () => {
    const { fire, shown } = loadWorker();
    await fire('push', pushOf('{not json'));
    await fire('push', { data: null });
    expect(shown.map((entry) => entry.title)).toEqual(['EML Cockpit', 'EML Cockpit']);
  });

  it('hands a tap to the open cockpit, which opens the session without a reload', async () => {
    const open = client(`${ORIGIN}/`);
    const { fire, self } = loadWorker([client('https://elsewhere.example/'), open]);
    await fire('notificationclick', tap(`${ORIGIN}/?session=s1`));
    expect(open.postMessage).toHaveBeenCalledWith({ type: 'open-session', sessionId: 's1' });
    expect(open.focus).toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens the cockpit at the session when none is open', async () => {
    const { fire, self } = loadWorker([]);
    await fire('notificationclick', tap(`${ORIGIN}/?session=s1`));
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/?session=s1`);
  });
});
