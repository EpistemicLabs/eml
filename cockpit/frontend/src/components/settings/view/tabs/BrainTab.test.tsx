// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SPACE_HEADER } from '@/lib/space-header';
import { getActiveSpaceId } from '@/stores/usePaneStore';
import { loadSpaces } from '@/stores/useSpaceStore';
import BrainTab from './BrainTab';

// The list picks whose details show; the cockpit stays in the space it is in.

const SPACES = [
  { id: 'main-id', name: 'Main', main: true, color: 'coral' },
  { id: 'other-id', name: 'Other', main: false, color: 'violet' },
];

const brainInfo = (id: string) => ({ source: 'local', home: '/home', brainId: `brain-of-${id}`, brainFile: `/${id}.db`, agents: [], users: [] });

function hostAnswers() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const space = new Headers(init?.headers).get(SPACE_HEADER) ?? 'none';
    const body = url.startsWith('/api/spaces') ? { spaces: SPACES }
      : url.startsWith('/api/brain-info') ? brainInfo(space)
      : url.startsWith('/api/brain-backups') ? { backups: [], backup: {} }
      : {};
    return new Response(JSON.stringify(body));
  });
}

let fetchMock: ReturnType<typeof hostAnswers>;

beforeEach(async () => {
  fetchMock = hostAnswers();
  vi.stubGlobal('fetch', fetchMock);
  await loadSpaces();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Settings › Brain', () => {
  it('has no way to switch the space from the list', async () => {
    render(<BrainTab />);
    await screen.findByText('brain-of-main-id');
    expect(screen.queryByRole('button', { name: 'Switch' })).toBeNull();
    expect(screen.queryByText('active')).toBeNull();
  });

  it('shows the details of a picked space and leaves the open one alone', async () => {
    const open = getActiveSpaceId();
    render(<BrainTab />);
    await screen.findByText('brain-of-main-id');
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    await screen.findByText('brain-of-other-id');
    expect(screen.getByText('Backups of Other')).toBeTruthy();
    expect(getActiveSpaceId()).toBe(open);
  });

  it('backs up the picked space', async () => {
    render(<BrainTab />);
    await screen.findByText('brain-of-main-id');
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    await screen.findByText('brain-of-other-id');
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/brain-backups' && init?.method === 'POST');
      expect(new Headers(post?.[1]?.headers).get(SPACE_HEADER)).toBe('other-id');
    });
  });
});
