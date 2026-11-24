// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { ProjectSession } from '@/types/app';

const api = vi.hoisted(() => ({ renameSession: vi.fn(async () => new Response('{}')) }));
const panes = vi.hoisted(() => ({
  current: { id: 'pane-1', paneView: 'chat', sessionId: 's1', title: undefined as string | undefined },
  renamePane: vi.fn((_id: string, title: string) => { panes.current.title = title.trim() || undefined; }),
}));
const refreshProjects = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/utils/api', () => ({ api }));
vi.mock('@/stores/usePaneStore', () => ({ usePane: () => panes.current, renamePane: panes.renamePane, isPaneProtected: () => false }));
vi.mock('@/contexts/PaletteOpsContext', () => ({ usePaletteOps: () => ({ refreshProjects }) }));
vi.mock('@/stores/useTeamStore', () => ({ useWritable: () => ({ writable: true, reason: null }) }));
vi.mock('@/lib/notes', () => ({ useNote: () => ({ data: undefined }), useRenameNote: () => ({ mutate: vi.fn() }) }));
vi.mock('@/lib/providers', () => ({ useProviders: () => ({ data: [] }) }));

import MainContentTitle from './MainContentTitle';

const session = (patch: Partial<ProjectSession> = {}) => ({ id: 's1', summary: 'Fix the stock answers', title: null, taskId: 'task-1', ...patch }) as unknown as ProjectSession;

// The title is an h2 that acts as a button (click to rename).
const heading = () => document.querySelector('h2')!.textContent;

function rename(to: string) {
  fireEvent.click(document.querySelector('h2')!);
  const input = screen.getByRole('textbox', { name: 'Pane name' });
  fireEvent.change(input, { target: { value: to } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('the heading of a session', () => {
  beforeEach(() => {
    panes.current = { id: 'pane-1', paneView: 'chat', sessionId: 's1', title: undefined };
    api.renameSession.mockReset();
    api.renameSession.mockImplementation(async () => new Response('{}'));
    panes.renamePane.mockClear();
    refreshProjects.mockClear();
  });
  afterEach(cleanup);

  it('shows the task\'s name for a session with a task, over a name the pane kept', () => {
    panes.current.title = 'An old pane name';
    render(<MainContentTitle paneId="pane-1" selectedProject={null} selectedSession={session()} />);
    expect(heading()).toBe('Fix the stock answers');
  });

  it('renames the task through the host, shows the new name at once, and keeps no pane name', async () => {
    panes.current.title = 'An old pane name';
    const { rerender } = render(<MainContentTitle paneId="pane-1" selectedProject={null} selectedSession={session()} />);
    rename('Check the stock');
    expect(heading()).toBe('Check the stock');
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith('s1', 'Check the stock'));
    expect(panes.renamePane).toHaveBeenCalledWith('pane-1', '');
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
    rerender(<MainContentTitle paneId="pane-1" selectedProject={null} selectedSession={session({ summary: 'Check the stock' })} />);
    expect(heading()).toBe('Check the stock');
  });

  it('goes back to the task\'s name when the host refuses the rename', async () => {
    api.renameSession.mockImplementation(async () => new Response('{}', { status: 502 }));
    render(<MainContentTitle paneId="pane-1" selectedProject={null} selectedSession={session()} />);
    rename('Check the stock');
    await waitFor(() => expect(heading()).toBe('Fix the stock answers'));
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  it('sends a chat pane\'s rename of a session without a task to the host, and keeps it on the pane', async () => {
    render(<MainContentTitle paneId="pane-1" selectedProject={null} selectedSession={session({ taskId: null, summary: 'First prompt' })} />);
    rename('My session');
    expect(panes.renamePane).toHaveBeenCalledWith('pane-1', 'My session');
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith('s1', 'My session'));
  });
});
