// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { Board, BoardTask } from '@/lib/task-board';

const opened = vi.hoisted(() => ({ calls: [] as unknown[][] }));
// cmdk measures its list; jsdom has no ResizeObserver or scrollIntoView.
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
Element.prototype.scrollIntoView = () => {};
const task = (id: string, patch: Partial<BoardTask> = {}): BoardTask => ({
  id, spaceId: 'eml', spaceName: 'EML', project: 'ui', title: id, status: 'active', parentId: null, updatedAt: null,
  turn: 'waiting_on_others', coverage: { ok: true, how: 'working' }, urgency: 0, important: false, onBoard: false, sessionIds: [], working: false, nextRunAt: null, ...patch,
});
const board = {
  tasks: [task('phone-close-button', { turn: 'needs_you', sessionIds: ['s-here'] }), task('cockpit-media-viewer', { status: 'planned', turn: null }), task('northwind-rescue', { project: 'northwind' })],
  projects: [{ spaceId: 'eml', id: 'ui', name: 'EML UI/UX', goal: null }, { spaceId: 'eml', id: 'northwind', name: 'Northwind', goal: null }],
  spaces: [], inbox: [], snoozed: [], events: [], counts: { needsYou: 1, inbox: 0 }, at: '', viewer: 'me',
} as unknown as Board;

vi.mock('@/lib/task-board', async (importOriginal) => ({ ...(await importOriginal<object>()), useTaskBoard: () => ({ data: board }) }));
vi.mock('@/components/sidebar/useAllSessions', () => ({ useAllSessions: () => ({ sessions: [], queued: [], refresh: () => {} }) }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ toggleDarkMode: () => {} }) }));
vi.mock('@/lib/pane-views', () => ({ useViewEnabled: () => () => true }));
vi.mock('@/lib/providers', () => ({ useProviders: () => ({ data: [] }) }));
vi.mock('@/lib/queries', () => ({ useList: () => ({ data: undefined, isFetching: false }) }));
vi.mock('@/lib/engram-panel', () => ({ useEngramPanel: () => ({ open: () => {} }) }));
vi.mock('@/stores/useSpaceStore', async (importOriginal) => ({ ...(await importOriginal<object>()), useSpaces: () => [{ id: 'eml', name: 'EML', main: false, agent: null, upgrade: null }] }));
vi.mock('@/stores/usePaneStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDesks: () => [{ id: 'd1', name: 'Desk 1', spaceId: 'eml', panes: [{ id: 'p1', sessionId: 's-here' }] }],
  useActiveDeskId: () => 'd1',
  useActiveSpaceId: () => 'eml',
}));
vi.mock('./openTask', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openTask: async (...args: unknown[]) => { opened.calls.push(args); },
}));

const { default: CommandPalette } = await import('./CommandPalette');
const { openTaskSearch } = await import('./openTask');

afterEach(() => { cleanup(); opened.calls = []; });

const renderPalette = () => render(<CommandPalette projects={[]} selectedProject={null} onStartNewChat={() => {}} onOpenSettings={() => {}} onOpenSession={() => {}} />);

describe('opening a task from ⌘K', () => {
  it('opens on the Open task page with what needs you first, each row saying where it is and what Enter does', () => {
    renderPalette();
    act(() => openTaskSearch());
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options[0]).toContain('Phone close button');
    expect(options[0]).toContain('Open here · pane 1');
    expect(options[0]).toContain('Go to pane');
    expect(options[1]).toContain('Cockpit media viewer');
    expect(options[1]).toContain('No session yet');
    expect(screen.getByText(/open in a new desk/)).toBeTruthy();
  });

  it('keeps to one project when opened from the tasks card\'s more link', () => {
    renderPalette();
    act(() => openTaskSearch('northwind'));
    expect(screen.getAllByRole('option').map((o) => o.textContent ?? '').join('|')).toMatch(/^[^|]*Northwind rescue[^|]*$/);
  });

  it('opens the picked task on this desk with Enter, and in a new desk with ⌘ or Ctrl Enter', async () => {
    renderPalette();
    act(() => openTaskSearch());
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'media' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, ctrlKey: true });
    await act(async () => {});
    expect(opened.calls[0]).toEqual([expect.objectContaining({ id: 'cockpit-media-viewer' }), { kind: 'none' }, { newDesk: true }]);
  });
});
