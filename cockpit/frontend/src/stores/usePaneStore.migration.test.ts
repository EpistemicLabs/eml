import { beforeEach, describe, expect, it, vi } from 'vitest';

// Chat is the only view of a session now: a layout an earlier version stored loads with its terminal panes in
// the chat, without the per-session view memory, and without the terminal workers' first-message queue.

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
});
vi.stubGlobal('window', { localStorage: globalThis.localStorage, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });

const legacy = {
  desks: [{
    id: 'd', slug: 'desk-1', name: 'Desk 1', activePaneId: 'a',
    panes: [
      { id: 'a', projectId: 'p', sessionId: 's-a', paneView: 'terminal', label: 'Terminal 1' },
      { id: 'b', projectId: 'p', sessionId: 's-b', paneView: 'brain' },
      { id: 'c', projectId: 'p', sessionId: 's-c', paneView: 'kanban', label: 'Terminal 3' },
      { id: 'n', projectId: 'p', sessionId: null, paneView: 'note', noteId: 'note-1' },
    ],
  }],
  activeDeskId: 'd',
  sessionViews: { 's-b': 'terminal', 's-a': 'chat' },
};

describe('loading a layout from before chat was the only view', () => {
  let store: typeof import('./usePaneStore');

  beforeEach(async () => {
    vi.resetModules();
    storage.clear();
    storage.set('cockpit-pane-layout', JSON.stringify(legacy));
    storage.set('cockpit-pending-shell-commands', JSON.stringify({ a: 'Do the thing' }));
    store = await import('./usePaneStore');
  });

  it('opens a terminal pane, and a view this version does not know, in the chat, with a chat label', () => {
    expect(store.getPane('a')).toMatchObject({ paneView: 'chat', sessionId: 's-a', label: 'Chat 1' });
    expect(store.getPane('c')).toMatchObject({ paneView: 'chat', label: 'Chat 3' });
    expect(store.getPane('a')?.terminalFallback).toBeUndefined();
  });

  it('keeps the other views as they were: the session view memory no longer moves a pane', () => {
    expect(store.getPane('b')).toMatchObject({ paneView: 'brain' });
    expect(store.getPane('b')?.label).toBeUndefined();
    expect(store.getPane('n')).toMatchObject({ paneView: 'note', noteId: 'note-1' });
  });

  it('writes the layout back without the view memory, and drops the first-message queue', () => {
    const saved = JSON.parse(storage.get('cockpit-pane-layout')!) as Record<string, unknown>;
    expect(saved).not.toHaveProperty('sessionViews');
    expect(JSON.stringify(saved)).not.toContain('"terminal"');
    expect(storage.has('cockpit-pending-shell-commands')).toBe(false);
  });

  it('parses a pane on its own the same way', () => {
    expect(store.parsePane({ id: 'x', paneView: 'terminal', label: 'Terminal 2' })).toMatchObject({ paneView: 'chat', label: 'Chat 2' });
    expect(store.parsePane({ id: 'y' })).toMatchObject({ paneView: 'chat' });
    expect(store.parsePane({ id: 'z', paneView: 'brain', terminalFallback: true })?.terminalFallback).toBeUndefined();
    expect(store.parsePane({ id: 'w', paneView: 'chat', terminalFallback: true })?.terminalFallback).toBe(true);
  });

  it('starts a new desk and a cleared pane in the chat', () => {
    store.createDesk({ name: 'Two' });
    expect(store.getActivePane()).toMatchObject({ paneView: 'chat' });
    store.clearPane('a');
    expect(store.getPane('a')).toMatchObject({ paneView: 'chat', projectId: null });
  });
});
