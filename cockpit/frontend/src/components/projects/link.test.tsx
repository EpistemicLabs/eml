// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import type { Project } from '@/types/app';

const mocks = vi.hoisted(() => ({
  brainGet: vi.fn(),
  brainPost: vi.fn(),
  linkProject: vi.fn(),
  deleteProject: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ brainGet: mocks.brainGet, brainPost: mocks.brainPost }));
vi.mock('@/utils/api', () => ({ api: { linkProject: mocks.linkProject, deleteProject: mocks.deleteProject } }));
vi.mock('@/stores/useTeamStore', () => ({ useWritable: () => ({ writable: true, reason: null }) }));

import LinkFoldersBanner from '@/components/app/LinkFoldersBanner';
import LinkProjectDialog from './LinkProjectDialog';

const ok = (body: unknown = { success: true }) => new Response(JSON.stringify(body));
const fail = (status: number, message: string) => new Response(JSON.stringify({ error: { code: 'X', message } }), { status });

const scratch: Project = { projectId: 'scratch', displayName: 'Scratch', kind: 'folder', linkable: true, fullPath: '/work/scratch', sessionMeta: { total: 2 } };
const notes: Project = { projectId: 'notes', displayName: 'Lighthouse', kind: 'folder', linkable: true, fullPath: '/work/notes', sessionMeta: { total: 1 } };
const ownFolder: Project = { projectId: 'hygiene', displayName: 'Brain hygiene', kind: 'folder', linkable: false, fullPath: '/home/.cockpit/hygiene' };

// The brain has Lighthouse (free), Atlas (runs in another folder) and an archived one.
const brainProjects = [
  { id: 'lighthouse', name: 'Lighthouse', status: 'active' },
  { id: 'atlas', name: 'Atlas', status: 'active' },
  { id: 'old', name: 'Old', status: 'archived' },
];
const cockpitProjects: Project[] = [
  { projectId: 'bp-atlas', kind: 'brain', brainProjectId: 'atlas', displayName: 'Atlas', fullPath: '/work/atlas' },
];

const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

beforeEach(() => {
  mocks.brainGet.mockResolvedValue({ projects: brainProjects });
  mocks.brainPost.mockImplementation(async (_path: string, body: { id: string }) => ({ object: body, created: true }));
  mocks.linkProject.mockResolvedValue(ok());
  mocks.deleteProject.mockResolvedValue(ok());
  vi.stubGlobal('fetch', vi.fn(async () => ok({ projects: cockpitProjects })));
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.values(mocks).forEach((m) => m.mockReset());
});

describe('link to brain project dialog', () => {
  it('offers the open brain projects; one in another folder is disabled, archived ones are left out', async () => {
    wrap(<LinkProjectDialog project={scratch} onClose={() => {}} onLinked={() => {}} />);
    const select = screen.getByRole('combobox', { name: 'Existing project' });
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Lighthouse' })).toBeTruthy());
    expect((within(select).getByRole('option', { name: 'Atlas (runs in another folder)' }) as HTMLOptionElement).disabled).toBe(true);
    expect(within(select).queryByRole('option', { name: 'Old' })).toBeNull();
  });

  it('links to the picked project', async () => {
    const onLinked = vi.fn();
    const onClose = vi.fn();
    wrap(<LinkProjectDialog project={scratch} onClose={onClose} onLinked={onLinked} />);
    const select = screen.getByRole('combobox', { name: 'Existing project' });
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Lighthouse' })).toBeTruthy());
    fireEvent.change(select, { target: { value: 'lighthouse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(mocks.linkProject).toHaveBeenCalledWith('scratch', 'lighthouse', undefined);
    expect(onClose).toHaveBeenCalled();
  });

  it('makes a new project named after the folder, then links it', async () => {
    const onLinked = vi.fn();
    wrap(<LinkProjectDialog project={scratch} onClose={() => {}} onLinked={onLinked} />);
    fireEvent.click(screen.getByRole('radio', { name: 'New project' }));
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Scratch');
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(mocks.brainPost).toHaveBeenCalledWith('/object/project', expect.objectContaining({ id: 'scratch', name: 'Scratch' }), undefined);
    expect(mocks.linkProject).toHaveBeenCalledWith('scratch', 'scratch', undefined);
  });

  it('shows the host\'s refusal inline and keeps the dialog; a retry does not make the project twice', async () => {
    mocks.linkProject.mockResolvedValueOnce(fail(502, 'The brain did not answer. Nothing was changed; try again.'));
    const onLinked = vi.fn();
    wrap(<LinkProjectDialog project={scratch} onClose={() => {}} onLinked={onLinked} />);
    fireEvent.click(screen.getByRole('radio', { name: 'New project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The brain did not answer');
    expect(onLinked).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(mocks.brainPost).toHaveBeenCalledTimes(1);
    expect(mocks.linkProject).toHaveBeenLastCalledWith('scratch', 'scratch', undefined);
  });
});

describe('folders banner and list', () => {
  it('counts only the linkable folders and is gone when none is left', () => {
    const props = { onChanged: () => {}, onRemoved: () => {} };
    const { rerender } = wrap(<LinkFoldersBanner projects={[scratch, notes, ownFolder]} {...props} />);
    expect(screen.getByRole('status').textContent).toContain('2 folders aren’t in a brain project yet.');
    rerender(<QueryClientProvider client={new QueryClient()}><LinkFoldersBanner projects={[ownFolder]} {...props} /></QueryClientProvider>);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('applies each row in turn, says which worked and keeps the failed one', async () => {
    mocks.linkProject.mockImplementation(async (id: string) => (id === 'notes' ? fail(409, 'Lighthouse already runs in /x') : ok()));
    const onChanged = vi.fn();
    const onRemoved = vi.fn();
    wrap(<LinkFoldersBanner projects={[scratch, notes]} onChanged={onChanged} onRemoved={onRemoved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link them' }));
    const dialog = screen.getByRole('dialog', { name: 'Link folders to brain projects' });
    expect(within(dialog).getByText(/2 sessions/)).toBeTruthy();
    // First guesses: Lighthouse the brain project of that name; Scratch has none and waits (later), nothing is made unasked.
    const scratchChoice = screen.getByRole('combobox', { name: 'What to do with Scratch' }) as HTMLSelectElement;
    const notesChoice = screen.getByRole('combobox', { name: 'What to do with Lighthouse' }) as HTMLSelectElement;
    await waitFor(() => expect(notesChoice.value).toBe('link:lighthouse'));
    expect(scratchChoice.value).toBe('later');
    fireEvent.change(scratchChoice, { target: { value: 'remove' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(within(dialog).getByText('Removed from the cockpit')).toBeTruthy());
    expect(await within(dialog).findByText('Lighthouse already runs in /x')).toBeTruthy();
    expect(mocks.deleteProject).toHaveBeenCalledWith('scratch', false, undefined);
    expect(onRemoved).toHaveBeenCalledWith('scratch');
    expect(onChanged).toHaveBeenCalledTimes(1);
    // The failed row stays to try again; the done one has no choice left.
    expect(screen.queryByRole('combobox', { name: 'What to do with Scratch' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'What to do with Lighthouse' })).toBeTruthy();
    expect(within(dialog).getByText('1 done · 1 failed')).toBeTruthy();
  });

  it('Later leaves a folder alone', async () => {
    wrap(<LinkFoldersBanner projects={[scratch]} onChanged={() => {}} onRemoved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link it' }));
    const choice = screen.getByRole('combobox', { name: 'What to do with Scratch' }) as HTMLSelectElement;
    await waitFor(() => expect(choice.disabled).toBe(false));
    fireEvent.change(choice, { target: { value: 'later' } });
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
