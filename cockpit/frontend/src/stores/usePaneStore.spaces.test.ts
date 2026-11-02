import { beforeEach, describe, expect, it, vi } from 'vitest';

// A click in the sidebar's All view opens a session of another brain space.
// Its pane must land on a desk of that space: the desk decides the token and
// the agent a session starts with.

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
});
vi.stubGlobal('window', { localStorage: globalThis.localStorage, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });

const OTHER = 'other-space';

describe('opening a session of another space', () => {
  let store: typeof import('./usePaneStore');

  beforeEach(async () => {
    vi.resetModules();
    storage.clear();
    store = await import('./usePaneStore');
    store.setEmptyPaneTest((pane) => !pane.projectId);
  });

  const deskOfSession = (sessionId: string) =>
    store.getDesks().find((desk) => desk.panes.some((pane) => pane.sessionId === sessionId));

  it('switches the space first and puts the pane on a desk of that space', () => {
    expect(store.getActiveSpaceId()).toBeNull();
    store.openSessionInSpace(OTHER, { surface: 'terminal', projectId: 'p', sessionId: 's-1' });
    expect(store.getActiveSpaceId()).toBe(OTHER);
    expect(deskOfSession('s-1')?.spaceId).toBe(OTHER);
  });

  it('does not touch the panes of the space it left', () => {
    store.openInPane({ surface: 'terminal', projectId: 'p', sessionId: 'main-session' });
    store.openSessionInSpace(OTHER, { surface: 'terminal', projectId: 'p', sessionId: 's-1' });
    expect(deskOfSession('main-session')?.spaceId).toBeNull();
  });

  it('focuses a pane that already holds the session and moves the active space with it', () => {
    store.openSessionInSpace(OTHER, { surface: 'terminal', projectId: 'p', sessionId: 's-1' });
    const paneId = store.getActivePaneId();
    store.activateSpace(null);
    expect(store.getActiveSpaceId()).toBeNull();
    store.openSessionInSpace(OTHER, { surface: 'terminal', projectId: 'p', sessionId: 's-1' });
    expect(store.getActiveSpaceId()).toBe(OTHER);
    expect(store.getActivePaneId()).toBe(paneId);
    expect(store.getDesks().flatMap((desk) => desk.panes).filter((pane) => pane.sessionId === 's-1')).toHaveLength(1);
  });

  it('activating a pane on a desk of another space moves the active space too', () => {
    store.openSessionInSpace(OTHER, { surface: 'terminal', projectId: 'p', sessionId: 's-1' });
    const paneId = store.getActivePaneId();
    store.activateSpace(null);
    store.activatePane(paneId);
    expect(store.getActiveSpaceId()).toBe(OTHER);
  });

  it('opens a new session as the settings and provider say, an existing one as it was', () => {
    const viewOf = (paneId: string) => store.getDesks().flatMap((desk) => desk.panes).find((pane) => pane.id === paneId)?.paneView;
    expect(viewOf(store.openInPane({ surface: 'terminal', projectId: 'p1' }))).toBe('terminal');
    store.setDefaultProvider('claude');
    expect(viewOf(store.openInPane({ surface: 'terminal', projectId: 'p1' }))).toBe('chat');
    expect(viewOf(store.openInPane({ surface: 'terminal', projectId: 'p1', provider: 'codex' }))).toBe('terminal');
    expect(viewOf(store.openInPane({ surface: 'terminal', projectId: 'p1', sessionId: 'kept' }))).toBe('terminal');
    storage.set('cockpit-settings', JSON.stringify({ chatDefault: false }));
    expect(viewOf(store.openInPane({ surface: 'terminal', projectId: 'p1' }))).toBe('terminal');
  });
});
