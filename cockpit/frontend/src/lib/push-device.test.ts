import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { disablePush, enablePush, pushEnabled, pushEndpoint, sendTestPush } from './push';

// This device's subscription against a fake browser (service worker, push manager,
// permission) and a fake host answering the routes of host push-api.ts.

type Call = { method: string; url: string; body?: unknown };

function fakeSubscription(endpoint: string) {
  return { endpoint, unsubscribe: vi.fn(async () => true), toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }) };
}

let calls: Call[];
let answers: Record<string, { status: number; body: unknown }>;
let current: ReturnType<typeof fakeSubscription> | null;
let permission: NotificationPermission;
let subscribe: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls = [];
  answers = {};
  current = null;
  permission = 'granted';
  subscribe = vi.fn(async () => {
    current = fakeSubscription('https://push.example/new');
    return current;
  });
  const registration = { pushManager: { getSubscription: async () => current, subscribe } };
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X)',
    serviceWorker: { register: async () => registration, ready: Promise.resolve(registration), getRegistration: async () => registration },
  });
  vi.stubGlobal('Notification', { requestPermission: async () => permission });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const answer = answers[`${method} ${url.split('?')[0]}`] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('enablePush', () => {
  it('asks for permission, starts a fresh subscription with the host\'s key and hands it to the host', async () => {
    current = fakeSubscription('https://push.example/old');
    const old = current;
    answers['GET /api/push'] = { status: 200, body: { publicKey: 'BAEC', subscribed: false } };
    expect(await enablePush()).toBe('enabled');
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(calls.at(-1)).toEqual({ method: 'PUT', url: '/api/push/subscription', body: { endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' }, label: 'iPhone' } });
  });

  it('stops at a denied permission, and fails when the host gives no key or keeps no device', async () => {
    permission = 'denied';
    expect(await enablePush()).toBe('denied');
    expect(subscribe).not.toHaveBeenCalled();
    permission = 'granted';
    answers['GET /api/push'] = { status: 503, body: {} };
    expect(await enablePush()).toBe('failed');
    answers['GET /api/push'] = { status: 200, body: { publicKey: 'BAEC' } };
    answers['PUT /api/push/subscription'] = { status: 503, body: {} };
    expect(await enablePush()).toBe('failed');
  });
});

describe('pushEnabled', () => {
  it('is on only when the browser holds a subscription and the host knows it', async () => {
    expect(await pushEnabled()).toBe(false);
    current = fakeSubscription('https://push.example/a');
    answers['GET /api/push'] = { status: 200, body: { subscribed: false } };
    expect(await pushEnabled()).toBe(false);
    answers['GET /api/push'] = { status: 200, body: { subscribed: true } };
    expect(await pushEnabled()).toBe(true);
    expect(calls.at(-1)?.url).toBe('/api/push?endpoint=https%3A%2F%2Fpush.example%2Fa');
  });
});

describe('disablePush', () => {
  it('tells the host first, then drops the subscription', async () => {
    current = fakeSubscription('https://push.example/a');
    const subscription = current;
    await disablePush();
    expect(calls).toEqual([{ method: 'DELETE', url: '/api/push/subscription', body: { endpoint: 'https://push.example/a' } }]);
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });
});

describe('sendTestPush', () => {
  it('reads the host\'s answer: sent, gone or failed', async () => {
    expect(await sendTestPush()).toBe('gone');
    current = fakeSubscription('https://push.example/a');
    expect(await sendTestPush()).toBe('sent');
    for (const [status, retry, outcome] of [[404, false, 'gone'], [410, false, 'gone'], [502, true, 'failed']] as const) {
      answers['POST /api/push/test'] = { status, body: { error: { retry } } };
      expect(await sendTestPush()).toBe(outcome);
    }
  });
});

describe('pushEndpoint', () => {
  it('names this device\'s push address, or none', async () => {
    expect(await pushEndpoint()).toBeNull();
    current = fakeSubscription('https://push.example/a');
    expect(await pushEndpoint()).toBe('https://push.example/a');
  });
});
