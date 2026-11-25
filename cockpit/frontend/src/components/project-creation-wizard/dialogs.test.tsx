// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { Project } from '@/types/app';

const { never, brainPost, setProjectPath } = vi.hoisted(() => {
  const never = (): Promise<unknown> => new Promise(() => {});
  return { never, brainPost: vi.fn(never), setProjectPath: vi.fn(never) };
});
vi.mock('@/lib/api', () => ({ brainGet: async () => ({ projects: [{ id: 'lighthouse' }] }), brainPost }));
vi.mock('@/utils/api', () => ({ api: { setProjectPath } }));
vi.mock('@/stores/useTeamStore', () => ({ useWritable: () => ({ writable: true, reason: null }) }));
vi.mock('./data/folderApi', () => ({ fetchFolderListing: async () => ({ path: '/', suggestions: [] }) }));

import ProjectCreationWizard from './ProjectCreationWizard';
import ProjectFolderDialog from './ProjectFolderDialog';

afterEach(() => {
  cleanup();
  brainPost.mockReset().mockImplementation(never);
  setProjectPath.mockReset().mockImplementation(never);
});

const scrimOf = (dialog: HTMLElement) => dialog.previousElementSibling as HTMLElement;
const escape = () => fireEvent.keyDown(document, { key: 'Escape' });

function wizard(onClose = vi.fn(), onProjectCreated = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectCreationWizard onClose={onClose} onProjectCreated={onProjectCreated} />
    </QueryClientProvider>,
  );
  return { onClose, onProjectCreated, dialog: screen.getByRole('dialog', { name: 'Add project' }) };
}

const typeName = (name: string) => fireEvent.change(screen.getByPlaceholderText('e.g. Lighthouse'), { target: { value: name } });
const typeFolder = (path: string) => fireEvent.change(screen.getByPlaceholderText('/path/to/project or ~/project'), { target: { value: path } });

describe('add-project dialog', () => {
  it('closes on Escape but not on a click beside it, which would lose what was typed', () => {
    const { onClose, dialog } = wizard();
    fireEvent.click(scrimOf(dialog));
    expect(onClose).not.toHaveBeenCalled();
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open on Escape while it creates the project', async () => {
    const { onClose } = wizard();
    fireEvent.change(screen.getByPlaceholderText('e.g. Lighthouse'), { target: { value: 'Lighthouse' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Create project' }));
    escape();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('makes only brain projects: no folder-only mode, an optional folder instead', () => {
    wizard();
    expect(screen.queryByRole('radiogroup', { name: 'Project kind' })).toBeNull();
    expect(screen.queryByText('Local cockpit folder')).toBeNull();
    expect(screen.getByText('Folder (optional)')).toBeTruthy();
    expect(screen.getByText(/Leave it empty and the cockpit makes one/)).toBeTruthy();
  });

  it('creates the brain project with a fresh id and no folder call when the folder is empty', async () => {
    brainPost.mockResolvedValue({ object: { id: 'lighthouse-2' }, created: true });
    const { onProjectCreated } = wizard();
    typeName('Lighthouse');
    expect(await screen.findByText('project.lighthouse-2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(onProjectCreated).toHaveBeenCalledWith({ id: 'lighthouse-2' }));
    expect(brainPost).toHaveBeenCalledWith('/object/project', expect.objectContaining({ id: 'lighthouse-2', name: 'Lighthouse', status: 'active' }), undefined);
    expect(setProjectPath).not.toHaveBeenCalled();
  });

  it('sets the given folder on the new project', async () => {
    brainPost.mockResolvedValue({ object: { id: 'beacon' }, created: true });
    setProjectPath.mockResolvedValue(new Response(JSON.stringify({ project: {} })));
    const { onProjectCreated } = wizard();
    typeName('Beacon');
    typeFolder('/work/beacon');
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(onProjectCreated).toHaveBeenCalled());
    expect(setProjectPath).toHaveBeenCalledWith('bp-beacon', '/work/beacon');
  });

  it('says the project exists when its folder was not taken', async () => {
    brainPost.mockResolvedValue({ object: { id: 'beacon' }, created: true });
    setProjectPath.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Not a directory' } }), { status: 400 }));
    const { onClose, onProjectCreated } = wizard();
    typeName('Beacon');
    typeFolder('/nope');
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Beacon was created, but its folder was not set: Not a directory');
    expect(onProjectCreated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onProjectCreated).toHaveBeenCalledWith({ id: 'beacon' });
    expect(onClose).not.toHaveBeenCalled();
    expect(brainPost).toHaveBeenCalledTimes(1);
  });
});

describe('link-folder dialog', () => {
  const project = { projectId: 'p1', displayName: 'Lighthouse', fullPath: '/work/lighthouse' } as unknown as Project;

  it('closes on Escape but not on a click beside it, and not while it saves', () => {
    const onClose = vi.fn();
    render(<ProjectFolderDialog project={project} onClose={onClose} onSaved={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Change folder' });
    fireEvent.click(scrimOf(dialog));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Link folder' }));
    escape();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape when idle', () => {
    const onClose = vi.fn();
    render(<ProjectFolderDialog project={project} onClose={onClose} onSaved={() => {}} />);
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
