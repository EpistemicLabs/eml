// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { activateSpace } from '@/stores/usePaneStore';
import { loadSpaces } from '@/stores/useSpaceStore';
import { usePluginStates, useSetPluginEnabled } from './pane-views';

// A pane's plugin views follow the active space: each space has its own (host: /api/plugins?space=).

const SPACES = [
  { id: 'main-id', name: 'Main', main: true, shared: false, agent: 'juno' },
  { id: 'other-id', name: 'Other', main: false, shared: false, agent: 'juno' },
];

let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(async () => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    const body = url.startsWith('/api/spaces') ? { spaces: SPACES }
      : url.startsWith('/api/plugins') ? { plugins: [{ id: 'time', enabled: url.includes('other-id') }] }
      : {};
    return new Response(JSON.stringify(body));
  }));
  await loadSpaces();
  activateSpace('main-id');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

describe('pane views per space', () => {
  it('asks the host for the active space\'s plugins, and again for another space', async () => {
    const { result } = renderHook(() => usePluginStates(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ time: false }));
    expect(calls.some((c) => c.url === '/api/plugins?space=main-id')).toBe(true);
    act(() => activateSpace('other-id'));
    await waitFor(() => expect(result.current.data).toEqual({ time: true }));
    expect(calls.some((c) => c.url === '/api/plugins?space=other-id')).toBe(true);
  });

  it('switches a plugin in the active space only', async () => {
    const { result } = renderHook(() => useSetPluginEnabled(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: 'time', enabled: true }); });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ id: 'time', enabled: true, space: 'main-id' });
  });
});
