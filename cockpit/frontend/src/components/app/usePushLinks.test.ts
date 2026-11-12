// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openSession } from '@/components/jobs/jobs';
import { openLinkedSession, usePushLinks } from './usePushLinks';

// A tap on a notification opens its session: from the URL the service worker
// opens, or from its message to a cockpit that is open already.

vi.mock('@/components/jobs/jobs', () => ({ openSession: vi.fn() }));
vi.mock('@/stores/useSpaceStore', () => ({
  getSpaces: () => [{ id: 'main-id', name: 'Main', main: true }, { id: 'other-id', name: 'Other', main: false }],
  loadSpaces: async () => [],
  paneSpaceKey: (space: { main: boolean; id: string }) => (space.main ? null : space.id),
}));

const SESSIONS = [
  { id: 'chat-in-other', spaceId: 'other-id', projectId: 'p1', runtime: 'sdk' },
  { id: 'terminal-in-main', spaceId: 'main-id', projectId: 'p2', runtime: 'pty' },
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessions: SESSIONS }))));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('openLinkedSession', () => {
  it('opens the session in its own space, with its project and view', async () => {
    await openLinkedSession('chat-in-other');
    expect(openSession).toHaveBeenCalledWith('other-id', 'chat-in-other', { projectId: 'p1', chat: true });
    await openLinkedSession('terminal-in-main');
    expect(openSession).toHaveBeenLastCalledWith(null, 'terminal-in-main', { projectId: 'p2', chat: false });
  });

  it('opens nothing for a session the host no longer knows', async () => {
    await openLinkedSession('gone');
    expect(openSession).not.toHaveBeenCalled();
  });
});

describe('usePushLinks', () => {
  it('opens the session the address names and takes it out of the address', async () => {
    window.history.replaceState(null, '', '/?session=chat-in-other&keep=1');
    renderHook(() => usePushLinks());
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('other-id', 'chat-in-other', { projectId: 'p1', chat: true }));
    expect(window.location.search).toBe('?keep=1');
  });

  it('opens the session the service worker sends to an open cockpit', async () => {
    const worker = new EventTarget();
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: worker });
    renderHook(() => usePushLinks());
    worker.dispatchEvent(new MessageEvent('message', { data: { type: 'open-session', sessionId: 'terminal-in-main' } }));
    await waitFor(() => expect(openSession).toHaveBeenCalledWith(null, 'terminal-in-main', { projectId: 'p2', chat: false }));
  });
});
