// @vitest-environment jsdom
// How the board loads again after a change: one load per change however many components read it, and a load under
// way is never thrown away (it starved the page while sessions worked: no board landed for minutes on a slow link).
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useClosedTasks, useTaskBoard } from './task-board';

/** A fetch whose answers come only when the test lets them: each call waits until `answer()`. */
function heldFetch() {
  const waiting: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise<Response>((resolve) => {
      const body = url.startsWith('/api/v1/tasks/closed') ? { tasks: [], more: false } : { tasks: [], inbox: [], snoozed: [], events: [], counts: { needsYou: 0, inbox: 0 } };
      waiting.push(() => resolve(new Response(JSON.stringify(body), { status: 200 })));
    });
  });
  const answer = async () => { await act(async () => { for (const go of waiting.splice(0)) go(); }); };
  const boardCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/v1/tasks/board').length;
  return { fetchMock, answer, boardCalls, signals };
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

const changed = () => act(() => { window.dispatchEvent(new CustomEvent('cockpit:tasks', { detail: { changes: [] } })); });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('loading the board again after a change', () => {
  it('loads it once per change, however many components read the board', async () => {
    const f = heldFetch();
    vi.stubGlobal('fetch', f.fetchMock);
    const { wrapper } = setup();
    for (let i = 0; i < 8; i++) renderHook(() => useTaskBoard(), { wrapper });
    expect(f.boardCalls()).toBe(1);
    await f.answer();

    changed();
    await waitFor(() => expect(f.boardCalls()).toBe(2));
    await f.answer();
    expect(f.boardCalls()).toBe(2);
  });

  it('keeps a load under way and loads exactly once more after it, however many changes came meanwhile', async () => {
    const f = heldFetch();
    vi.stubGlobal('fetch', f.fetchMock);
    const { wrapper } = setup();
    const { result } = renderHook(() => useTaskBoard(), { wrapper });
    await f.answer();

    changed();
    await waitFor(() => expect(f.boardCalls()).toBe(2));
    changed();
    changed();
    changed();
    expect(f.boardCalls()).toBe(2);
    expect(f.signals.every((s) => !s.aborted)).toBe(true);

    await f.answer();
    await waitFor(() => expect(f.boardCalls()).toBe(3));
    await f.answer();
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(f.boardCalls()).toBe(3);
  });

  it('loads once more after a load that started before the change', async () => {
    const f = heldFetch();
    vi.stubGlobal('fetch', f.fetchMock);
    const { wrapper } = setup();
    renderHook(() => useTaskBoard(), { wrapper });
    // The first load is still out when the change comes: it may have read the host before it.
    changed();
    expect(f.boardCalls()).toBe(1);
    await f.answer();
    await waitFor(() => expect(f.boardCalls()).toBe(2));
  });

  it('stops listening once no component reads the board', async () => {
    const f = heldFetch();
    vi.stubGlobal('fetch', f.fetchMock);
    const { wrapper } = setup();
    const a = renderHook(() => useTaskBoard(), { wrapper });
    const b = renderHook(() => useTaskBoard(), { wrapper });
    await f.answer();
    a.unmount();
    b.unmount();
    changed();
    await act(async () => { await Promise.resolve(); });
    expect(f.boardCalls()).toBe(1);
  });

  it('hands the query\'s abort signal to fetch, so a load given up on stops downloading', async () => {
    const f = heldFetch();
    vi.stubGlobal('fetch', f.fetchMock);
    const { client, wrapper } = setup();
    renderHook(() => useTaskBoard(), { wrapper });
    expect(f.signals).toHaveLength(1);
    await act(async () => { await client.cancelQueries({ queryKey: ['task-board'] }); });
    expect(f.signals[0].aborted).toBe(true);
  });

  it('loads each project\'s closed tasks once per change too', async () => {
    const f = heldFetch();
    vi.stubGlobal('fetch', f.fetchMock);
    const { wrapper } = setup();
    const projects = [{ spaceId: 'main', project: 'one', limit: 20 }];
    renderHook(() => useClosedTasks(projects, true), { wrapper });
    renderHook(() => useClosedTasks(projects, true), { wrapper });
    const closedCalls = () => f.fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/v1/tasks/closed')).length;
    expect(closedCalls()).toBe(1);
    await f.answer();
    changed();
    await waitFor(() => expect(closedCalls()).toBe(2));
  });
});
