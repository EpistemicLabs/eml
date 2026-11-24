import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
});
vi.stubGlobal('window', { localStorage: globalThis.localStorage, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });

// A file pinned from the media viewer ("Open as pane"): a pane of its own, kept with the layout.
describe('a file pane', () => {
  let store: typeof import('./usePaneStore');

  const load = async () => {
    vi.resetModules();
    store = await import('./usePaneStore');
    store.setEmptyPaneTest((pane) => (pane.paneView === 'file' ? !pane.filePath : !pane.projectId));
  };

  beforeEach(async () => {
    storage.clear();
    await load();
  });

  it('opens next to a busy pane, holds no session and survives a reload', async () => {
    const first = store.getActiveDesk().panes[0].id;
    store.updatePane(first, { projectId: 'p' });
    const id = store.openInPane({ surface: 'file', projectId: 'p', filePath: '/w/out/a.csv' });
    expect(id).not.toBe(first);
    expect(store.getPane(id)).toMatchObject({ paneView: 'file', filePath: '/w/out/a.csv', sessionId: null });

    await load();
    expect(store.getPane(id)).toMatchObject({ paneView: 'file', filePath: '/w/out/a.csv', sessionId: null });
  });

  it('takes an empty pane, dropping the session id it was minted with', () => {
    const empty = store.getActiveDesk().panes[0];
    expect(empty.sessionId).toBeTruthy();
    const id = store.openInPane({ surface: 'file', projectId: null, filePath: '/w/b.pdf' });
    expect(id).toBe(empty.id);
    expect(store.getPane(id)).toMatchObject({ paneView: 'file', filePath: '/w/b.pdf', sessionId: null });
  });

  it('is found again instead of opened twice', () => {
    store.updatePane(store.getActiveDesk().panes[0].id, { projectId: 'p' });
    const id = store.openInPane({ surface: 'file', projectId: 'p', filePath: '/w/c.md' });
    store.activatePane(store.getActiveDesk().panes[0].id);
    expect(store.openInPane({ surface: 'file', projectId: 'p', filePath: '/w/c.md' })).toBe(id);
    expect(store.getActiveDesk().panes).toHaveLength(2);
  });

  it('drops a stored file path that is not absolute', async () => {
    storage.set('cockpit-pane-layout', JSON.stringify({
      desks: [{ id: 'd', slug: 'desk-1', name: 'Desk 1', panes: [{ id: 'x', paneView: 'file', filePath: 'relative.csv' }], activePaneId: 'x' }],
      activeDeskId: 'd',
    }));
    await load();
    expect(store.getPane('x')?.filePath).toBeUndefined();
  });
});
