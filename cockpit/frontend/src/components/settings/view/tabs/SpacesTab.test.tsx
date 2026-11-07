// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SPACE_HEADER } from '@/lib/space-header';
import { SETTINGS_MAIN_TABS } from '../../constants/constants';
import { getActiveSpaceId } from '@/stores/usePaneStore';
import { getSpaces, loadSpaces } from '@/stores/useSpaceStore';
import SpacesTab from './SpacesTab';

// The list picks whose details show; the cockpit stays in the space it is in.

const SPACES = [
  { id: 'main-id', name: 'Main', main: true, shared: false, agent: 'juno', agentName: 'Juno', color: 'coral' },
  { id: 'other-id', name: 'Other', main: false, shared: false, agent: 'juno', agentName: 'Juno', color: 'violet' },
  { id: 'nova-id', name: 'Nova home', main: false, shared: false, agent: 'nova', agentName: 'Nova', color: 'slate' },
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

describe('Settings › Spaces', () => {
  it('has no way to switch the space from the list', async () => {
    render(<SpacesTab tab={SETTINGS_MAIN_TABS[0]} />);
    await screen.findByText('/main-id.db');
    expect(screen.queryByRole('button', { name: 'Switch' })).toBeNull();
    expect(screen.queryByText('active')).toBeNull();
  });

  it('shows the details of a picked space and leaves the open one alone', async () => {
    const open = getActiveSpaceId();
    render(<SpacesTab tab={SETTINGS_MAIN_TABS[0]} />);
    await screen.findByText('/main-id.db');
    fireEvent.click(screen.getAllByRole('button', { name: 'Other' })[0]);
    await screen.findByText('/other-id.db');
    expect(screen.getByText('Backups of Other')).toBeTruthy();
    expect(getActiveSpaceId()).toBe(open);
  });

  it('picks a space from the list and from the tabs alike', async () => {
    render(<SpacesTab tab={SETTINGS_MAIN_TABS[0]} />);
    await screen.findByText('/main-id.db');
    const [row, tab] = screen.getAllByRole('button', { name: 'Other' });
    fireEvent.click(tab);
    await screen.findByText('/other-id.db');
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(tab.getAttribute('aria-pressed')).toBe('true');
  });

  it('deletes a further local space only with its name typed, and an agent\'s main space never', async () => {
    render(<SpacesTab tab={SETTINGS_MAIN_TABS[0]} />);
    await screen.findByText('/main-id.db');
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    await screen.findByText("This is Juno's main space. It cannot be deleted.");
    fireEvent.click(screen.getAllByRole('button', { name: 'Nova home' })[0]);
    await screen.findByText("This is Nova's main space. It cannot be deleted.");
    fireEvent.click(screen.getAllByRole('button', { name: 'Other' })[0]);
    await screen.findByText('/other-id.db');
    const remove = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name of the space to delete'), { target: { value: 'Other' } });
    expect(remove.disabled).toBe(false);
  });

  it('keeps what the host says about a space: its colour, its agent\'s name, its own runtime', async () => {
    expect(getSpaces()[0]).toMatchObject({ color: 'coral', agentName: 'Juno', ownRuntime: false });
  });

  it('backs up the picked space', async () => {
    render(<SpacesTab tab={SETTINGS_MAIN_TABS[0]} />);
    await screen.findByText('/main-id.db');
    fireEvent.click(screen.getAllByRole('button', { name: 'Other' })[0]);
    await screen.findByText('/other-id.db');
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/brain-backups' && init?.method === 'POST');
      expect(new Headers(post?.[1]?.headers).get(SPACE_HEADER)).toBe('other-id');
    });
  });
});
