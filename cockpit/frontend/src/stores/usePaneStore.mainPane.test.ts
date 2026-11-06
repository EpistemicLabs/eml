import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
});
vi.stubGlobal('window', { localStorage: globalThis.localStorage, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });

const KEY = 'cockpit-pane-layout';

describe('a desk\'s main pane', () => {
  let store: typeof import('./usePaneStore');

  const load = async () => {
    vi.resetModules();
    store = await import('./usePaneStore');
    store.setEmptyPaneTest((pane) => !pane.projectId);
  };

  beforeEach(async () => {
    storage.clear();
    await load();
  });

  const desk = () => store.getActiveDesk();
  const ids = () => desk().panes.map((pane) => pane.id);
  const threePanes = () => {
    const first = ids()[0];
    store.updatePane(first, { projectId: 'p' });
    const second = store.addPane({ projectId: 'p' });
    const third = store.addPane({ projectId: 'p' });
    return [first, second, third];
  };

  it('moves to the front when made main and stays there as panes come', () => {
    const [first, , third] = threePanes();
    store.toggleMainPane(third);
    expect(desk().mainPaneId).toBe(third);
    expect(ids()[0]).toBe(third);
    const added = store.addPaneNextTo(third, { projectId: 'p' });
    expect(ids()[0]).toBe(third);
    expect(ids()[1]).toBe(added);
    const worker = store.addWorkerPane({ fromSessionId: desk().panes[0].sessionId, projectId: 'p', prompt: 'x', title: null });
    expect(ids()[0]).toBe(third);
    expect(ids()).toContain(worker);
    expect(ids()).toContain(first);
  });

  it('is one per desk, and turning it off leaves the even grid', () => {
    const [first, second] = threePanes();
    store.toggleMainPane(first);
    store.toggleMainPane(second);
    expect(desk().mainPaneId).toBe(second);
    store.toggleMainPane(second);
    expect(desk().mainPaneId).toBeUndefined();
  });

  it('cannot be closed until it stops being main', () => {
    const [first] = threePanes();
    store.toggleMainPane(first);
    store.removePane(first);
    expect(ids()).toContain(first);
    expect(store.isPaneProtected(first)).toBe(true);
    store.toggleMainPane(first);
    expect(store.isPaneProtected(first)).toBe(false);
    store.removePane(first);
    expect(ids()).not.toContain(first);
  });

  it('stays on its desk, while the other panes can still move', () => {
    const [first, second] = threePanes();
    store.toggleMainPane(first);
    const other = store.createDesk({ name: 'Other' });
    expect(store.canMovePaneToDesk(first, other)).toBe(false);
    expect(store.canMovePaneToDesk(second, other)).toBe(true);
    const source = store.getDeskOfPane(second)!;
    store.movePaneToDesk(second, other);
    expect(store.getDeskOfPane(second)?.id).toBe(other);
    expect(store.getDesks().find((d) => d.id === source.id)?.mainPaneId).toBe(first);
  });

  it('is dropped with the empty pane a moved pane replaces', () => {
    const [, second] = threePanes();
    const source = desk().id;
    const other = store.createDesk({ name: 'Other' });
    store.toggleMainPane(desk().panes[0].id);
    store.activateDesk(source);
    store.movePaneToDesk(second, other);
    const target = store.getDesks().find((d) => d.id === other)!;
    expect(target.panes.map((pane) => pane.id)).toEqual([second]);
    expect(target.mainPaneId).toBeUndefined();
  });

  describe('swapping', () => {
    it('trades the places of two panes', () => {
      const [first, second, third] = threePanes();
      store.swapPanes(first, third);
      expect(ids()).toEqual([third, second, first]);
    });

    it('hands the main role to the pane that lands in the main column', () => {
      const [first, second, third] = threePanes();
      store.toggleMainPane(first);
      store.swapPanes(third, first);
      expect(ids()).toEqual([third, second, first]);
      expect(desk().mainPaneId).toBe(third);
      expect(store.isPaneProtected(first)).toBe(false);
    });

    it('leaves the active pane and the sessions alone', () => {
      const [first, , third] = threePanes();
      const active = desk().activePaneId;
      const session = store.getPane(first)?.sessionId;
      store.swapPanes(first, third);
      expect(desk().activePaneId).toBe(active);
      expect(store.getPane(first)?.sessionId).toBe(session);
    });

    it('refuses a pane with itself, a pane of another desk and a pinned pane', () => {
      const [first, second, third] = threePanes();
      const other = store.createDesk({ name: 'Other' });
      const elsewhere = store.getDesks().find((d) => d.id === other)!.panes[0].id;
      expect(store.canSwapPanes(first, first)).toBe(false);
      expect(store.canSwapPanes(first, elsewhere)).toBe(false);
      store.updatePane(second, { pinned: true });
      expect(store.canSwapPanes(first, second)).toBe(false);
      expect(store.canSwapPanes(first, third)).toBe(true);
    });
  });

  describe('saved layouts', () => {
    const saved = (desk: Record<string, unknown>) => {
      storage.set(KEY, JSON.stringify({ desks: [{ id: 'd', slug: 'd', name: 'D', panes: [{ id: 'a' }, { id: 'b' }], activePaneId: 'a', ...desk }], activeDeskId: 'd' }));
    };

    it('keeps the main pane and its width across a reload', async () => {
      const [, second] = threePanes();
      store.toggleMainPane(second);
      store.setMainWidth(desk().id, 0.42);
      await load();
      expect(desk().mainPaneId).toBe(second);
      expect(desk().mainWidth).toBe(0.42);
      expect(ids()[0]).toBe(second);
    });

    it('remembers the width while main is off', async () => {
      const [first] = threePanes();
      store.toggleMainPane(first);
      store.setMainWidth(desk().id, 0.42);
      store.toggleMainPane(first);
      await load();
      expect(desk().mainPaneId).toBeUndefined();
      expect(desk().mainWidth).toBe(0.42);
    });

    it('loads an old layout as the even grid', async () => {
      saved({});
      await load();
      expect(ids()).toEqual(['a', 'b']);
      expect(desk().mainPaneId).toBeUndefined();
      expect(desk().mainWidth).toBeUndefined();
    });

    it('loads the layout of the old keys', async () => {
      storage.set(KEY, JSON.stringify({ spaces: [{ id: 'd', slug: 'd', name: 'D', panes: [{ id: 'a' }], activePaneId: 'a' }], activeSpaceId: 'd' }));
      await load();
      expect(ids()).toEqual(['a']);
      expect(desk().mainPaneId).toBeUndefined();
    });

    it('drops a main pane that is gone and a width that makes no sense', async () => {
      saved({ mainPaneId: 'gone', mainWidth: 7 });
      await load();
      expect(desk().mainPaneId).toBeUndefined();
      expect(desk().mainWidth).toBeUndefined();
    });

    it('puts a saved main pane first', async () => {
      saved({ mainPaneId: 'b', mainWidth: 0.5 });
      await load();
      expect(ids()).toEqual(['b', 'a']);
      expect(desk().mainWidth).toBe(0.5);
    });
  });
});
