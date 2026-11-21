// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { SidebarController } from '../../useSidebarController';
import { SidebarModals } from './SidebarModals';

afterEach(cleanup);

function controller(over: Partial<SidebarController>): SidebarController {
  return {
    wizardOpen: false,
    pendingProjectDelete: null,
    pendingSessionDelete: null,
    cancelProjectDelete: vi.fn(),
    confirmProjectDelete: vi.fn(),
    cancelSessionDelete: vi.fn(),
    confirmSessionDelete: vi.fn(),
    ...over,
  } as unknown as SidebarController;
}

describe('sidebar confirm prompts', () => {
  it('cancel a session delete on Escape and on a click beside them, never confirm it', () => {
    const c = controller({ pendingSessionDelete: { title: 'Old run' } as SidebarController['pendingSessionDelete'] });
    render(<SidebarModals controller={c} />);
    const prompt = screen.getByRole('alertdialog', { name: 'Delete session' });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(prompt.previousElementSibling as HTMLElement);
    expect(c.cancelSessionDelete).toHaveBeenCalledTimes(2);
    expect(c.confirmSessionDelete).not.toHaveBeenCalled();
  });

  it('cancel a folder removal on Escape, never remove it', () => {
    const c = controller({ pendingProjectDelete: { project: { projectId: 'p1', displayName: 'Lighthouse' }, sessionCount: 2 } as unknown as SidebarController['pendingProjectDelete'] });
    render(<SidebarModals controller={c} />);
    expect(screen.getByRole('alertdialog', { name: 'Remove folder from cockpit' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(c.cancelProjectDelete).toHaveBeenCalledTimes(1);
    expect(c.confirmProjectDelete).not.toHaveBeenCalled();
  });
});
