// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Engram } from '@/lib/types';
import type { Project } from '@/types/app';

// Advance task: on a desk as before, or with "No desk" on the host, unattended;
// the Tasks view starts it without a desk by default.

const panes = vi.hoisted(() => ({ addWorkerPane: vi.fn() }));
vi.mock('@/stores/usePaneStore', () => ({
  addWorkerPane: panes.addWorkerPane, ensureDeskBySlug: vi.fn(), getDesks: () => [], isEmptyPane: () => false,
  openInPane: vi.fn(), removePane: vi.fn(), useActiveDeskId: () => 'd1', useDesks: () => [{ id: 'd1', name: 'Desk 1' }],
}));
vi.mock('@/stores/useTeamStore', () => ({ useWritable: () => ({ writable: true, reason: null }) }));
vi.mock('@/stores/useSpaceStore', () => ({ useActiveSpace: () => ({ id: 'main', name: 'Main', main: true }) }));

const { TaskRunCard } = await import('./task-run');

const engram = { id: 't1', type: 'task', title: 'homepage-v4b', content: 'Build it', status: 'active', scope: 'project.website' } as unknown as Engram;
const projects = [{ projectId: 'bp-website', brainProjectId: 'website', displayName: 'Website', sessions: [] }] as unknown as Project[];

describe('the task run card', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); panes.addWorkerPane.mockClear(); });

  it('starts in the background by default in the Tasks view: the host gets the run, no pane opens', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'r1' }), { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    render(<TaskRunCard engram={engram} projects={projects} background />);
    fireEvent.click(screen.getByText('Advance task'));
    expect(screen.getByText(/runs without a pane/)).toBeTruthy();
    fireEvent.click(screen.getByText('Start run'));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/tasks/run');
    expect(JSON.parse(init.body as string)).toMatchObject({ projectId: 'bp-website', taskId: 't1', title: 'homepage-v4b' });
    expect(panes.addWorkerPane).not.toHaveBeenCalled();
  });

  it('opens on the current desk by default elsewhere: the host starts it with the task bound', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ sessionId: 's1' }), { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    render(<TaskRunCard engram={engram} projects={projects} />);
    fireEvent.click(screen.getByText('Advance task'));
    fireEvent.click(screen.getByText('Start run'));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/tasks/t1/start');
    expect(JSON.parse(init.body as string)).toMatchObject({ spaceId: 'main', projectId: 'bp-website', deskId: 'd1', title: 'homepage-v4b' });
    expect(panes.addWorkerPane).not.toHaveBeenCalled();
  });

  it('falls back to a terminal pane on the desk when the host cannot start it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    render(<TaskRunCard engram={engram} projects={projects} />);
    fireEvent.click(screen.getByText('Advance task'));
    fireEvent.click(screen.getByText('Start run'));
    await waitFor(() => expect(panes.addWorkerPane).toHaveBeenCalledWith(expect.objectContaining({ deskId: 'd1', taskId: 't1' })));
  });
});
