// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Project } from '@/types/app';

const api = vi.hoisted(() => ({
  renameProject: vi.fn(async () => new Response('{}')),
  setProjectStar: vi.fn(async () => new Response('{}')),
  setProjectHidden: vi.fn(async () => new Response('{}')),
  deleteProject: vi.fn(async () => new Response('{}')),
}));
vi.mock('@/utils/api', () => ({ api }));
vi.mock('@/components/project-creation-wizard', () => ({ default: () => <div role="dialog" aria-label="Add project wizard" /> }));
vi.mock('@/components/project-creation-wizard/ProjectFolderDialog', () => ({ default: () => <div role="dialog" aria-label="Folder dialog" /> }));

import { ProjectModals } from './ProjectModals';
import { ProjectsSection } from './ProjectsSection';
import { ADD_PROJECT_EVENT, useProjectActions } from './useProjectActions';

const brain: Project = { projectId: 'lighthouse', displayName: 'Lighthouse', kind: 'brain', fullPath: null, __spaceId: 'main', isStarred: false, hidden: false };
const folder: Project = { projectId: 'scratch', displayName: 'Scratch', kind: 'folder', fullPath: '/work/scratch', __spaceId: 'main', sessions: [{ id: 's1' } as never] };
const hiddenOne: Project = { ...brain, projectId: 'old', displayName: 'Old', hidden: true };

let changed = 0;
let removed: string[] = [];
function Harness() {
  const actions = useProjectActions({ onChanged: () => { changed++; }, onRemoved: (id) => { removed.push(id); } });
  return <><ProjectsSection projects={{ '': [brain, folder, hiddenOne] }} spaces={[{ key: '', name: 'Main' }]} actions={actions} /><ProjectModals actions={actions} /></>;
}

beforeEach(() => { changed = 0; removed = []; Object.values(api).forEach((f) => f.mockClear()); });
afterEach(cleanup);

describe('project management in Plan', () => {
  it('lists the projects, hidden ones only on request', () => {
    render(<Harness />);
    expect(screen.getByText('Lighthouse')).toBeTruthy();
    expect(screen.queryByText('Old')).toBeNull();
    fireEvent.click(screen.getByLabelText('Show 1 hidden'));
    expect(screen.getByText('Old')).toBeTruthy();
  });

  it('offers folder and visibility for a brain project, remove for a folder project', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Lighthouse actions' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Rename', 'Pin', 'Link a folder', 'Hide']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Scratch actions' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Rename', 'Pin', 'Remove from cockpit']);
  });

  it('hides a project on the host and reads the lists again', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Lighthouse actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    await waitFor(() => expect(changed).toBe(1));
    expect(api.setProjectHidden).toHaveBeenCalledWith('lighthouse', true, 'main');
  });

  it('asks before removing, and Escape cancels', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Scratch actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from cockpit' }));
    expect(screen.getByRole('alertdialog', { name: 'Remove folder from cockpit' }).textContent).toContain('1 session will be stopped');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(api.deleteProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Scratch actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from cockpit' }));
    fireEvent.click(screen.getByRole('button', { name: /keep transcripts/ }));
    await waitFor(() => expect(removed).toEqual(['scratch']));
    expect(api.deleteProject).toHaveBeenCalledWith('scratch', false, 'main');
  });

  it('renames inline; Escape keeps the old name', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Lighthouse actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByLabelText('Project name');
    fireEvent.change(field, { target: { value: 'Beacon' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(api.renameProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Lighthouse actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Beacon' } });
    fireEvent.keyDown(screen.getByLabelText('Project name'), { key: 'Enter' });
    await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith('lighthouse', 'Beacon', 'main'));
  });

  it('opens the add-project wizard from the button and from the launcher\'s event', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    expect(screen.getByRole('dialog', { name: 'Add project wizard' })).toBeTruthy();
    cleanup();
    render(<Harness />);
    act(() => { window.dispatchEvent(new Event(ADD_PROJECT_EVENT)); });
    expect(screen.getByRole('dialog', { name: 'Add project wizard' })).toBeTruthy();
  });
});
