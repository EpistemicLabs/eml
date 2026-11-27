// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpaceInfo } from '@/stores/useSpaceStore';

// Work on it today: the project's desk, made once, with today's lead in it —
// a new lead with its brief, or the one of today found again.

const store = vi.hoisted(() => {
  const desks: Array<{ id: string; panes: Array<{ id: string; sessionId?: string; empty?: boolean }> }> = [];
  return {
    desks, removePane: vi.fn(),
    activateDesk: vi.fn(), activatePane: vi.fn(), addWorkerPane: vi.fn(),
    ensureDeskBySlug: vi.fn((slug: string) => {
      if (!desks.find((d) => d.id === slug)) desks.push({ id: slug, panes: [{ id: 'starter', empty: true }] });
      return slug;
    }),
  };
});
vi.mock('@/stores/usePaneStore', () => ({
  activateDesk: store.activateDesk, activatePane: store.activatePane, addWorkerPane: store.addWorkerPane, ensureDeskBySlug: store.ensureDeskBySlug,
  getActiveSpaceId: () => null, getDesks: () => store.desks, removePane: store.removePane,
}));
vi.mock('@/stores/useSpaceStore', () => ({ paneSpaceKey: () => null, switchSpace: vi.fn() }));
vi.mock('@/stores/useTopViewStore', () => ({ setTopView: vi.fn() }));

const { openProjectLead } = await import('./project-lead');
const space = { id: 'main', name: 'Main', main: true } as SpaceInfo;

describe('opening a project lead', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('puts a new lead the host left to the pane on the project\'s new desk, with its brief, and removes the starter pane', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ sessionId: 'lead-1', existing: false, title: 'Lead · Website', prompt: 'You are the project lead' })));
    vi.stubGlobal('fetch', fetch);
    expect(await openProjectLead(space, 'bp-website', 'Website')).toBeNull();
    expect(store.ensureDeskBySlug).toHaveBeenCalledWith('project-bp-website', { name: 'Website', defaultProjectId: 'bp-website' });
    expect(store.addWorkerPane).toHaveBeenCalledWith(expect.objectContaining({
      deskId: 'project-bp-website', sessionId: 'lead-1', prompt: 'You are the project lead', projectId: 'bp-website',
    }));
    expect(store.removePane).toHaveBeenCalledWith('starter');
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ projectId: 'bp-website', chat: true });
    expect(store.activateDesk).toHaveBeenCalledWith('project-bp-website');
  });

  it('only joins a lead the host started in the chat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessionId: 'lead-2', existing: false, title: 'Lead · Shop', runtime: 'sdk' }))));
    expect(await openProjectLead(space, 'bp-shop', 'Shop')).toBeNull();
    expect(store.addWorkerPane).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'lead-2', prompt: '' }));
  });

  it('finds today\'s lead on its desk again, and says why when the host refuses', async () => {
    store.desks[0].panes = [{ id: 'pane-lead', sessionId: 'lead-1' }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessionId: 'lead-1', existing: true, title: 'Lead · Website' }))));
    expect(await openProjectLead(space, 'bp-website', 'Website')).toBeNull();
    expect(store.activatePane).toHaveBeenCalledWith('pane-lead');
    expect(store.addWorkerPane).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'no folder' } }), { status: 404 })));
    expect(await openProjectLead(space, 'bp-x', 'X')).toBe('no folder');
  });
});
