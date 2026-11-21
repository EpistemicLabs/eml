// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { Project } from '@/types/app';

const { never } = vi.hoisted(() => ({ never: () => new Promise<never>(() => {}) }));
vi.mock('@/lib/api', () => ({ brainGet: async () => ({ projects: [] }), brainPost: never }));
vi.mock('@/utils/api', () => ({ api: { setProjectPath: never } }));
vi.mock('@/stores/useTeamStore', () => ({ useWritable: () => ({ writable: true, reason: null }) }));
vi.mock('./data/folderApi', () => ({ createProject: never, fetchFolderListing: async () => [] }));

import ProjectCreationWizard from './ProjectCreationWizard';
import ProjectFolderDialog from './ProjectFolderDialog';

afterEach(cleanup);

const scrimOf = (dialog: HTMLElement) => dialog.previousElementSibling as HTMLElement;
const escape = () => fireEvent.keyDown(document, { key: 'Escape' });

function wizard(onClose = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectCreationWizard onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose, dialog: screen.getByRole('dialog', { name: 'Add project' }) };
}

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
    expect(onClose).not.toHaveBeenCalled();
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
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape when idle', () => {
    const onClose = vi.fn();
    render(<ProjectFolderDialog project={project} onClose={onClose} onSaved={() => {}} />);
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
