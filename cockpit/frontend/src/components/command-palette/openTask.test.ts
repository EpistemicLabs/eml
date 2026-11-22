// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import type { BoardTask } from '@/lib/task-board';

const calls = vi.hoisted(() => ({ log: [] as unknown[][], started: 's-new' as string | null, desks: ['d1'] }));
vi.mock('@/stores/usePaneStore', () => {
  const rec = (name: string, ret?: unknown) => (...args: unknown[]) => { calls.log.push([name, ...args]); return ret; };
  return {
    activateDesk: rec('activateDesk'),
    activatePane: rec('activatePane'),
    activateSpace: rec('activateSpace'),
    addWorkerPane: rec('addWorkerPane', 'p-worker'),
    ensureDeskBySlug: (...args: unknown[]) => { calls.log.push(['ensureDeskBySlug', ...args]); calls.desks.push('d-new'); return 'd-new'; },
    getActiveDeskId: () => 'd1',
    getActivePaneId: () => 'p1',
    getActiveSpaceId: () => 'eml',
    getDesks: () => calls.desks.map((id) => ({ id })),
    openInPane: rec('openInPane', 'p-opened'),
    paneHoldingSession: (id: string) => (id === 's-new' ? { id: 'p-started' } : undefined),
    removeDesk: rec('removeDesk'),
    removePane: rec('removePane'),
  };
});
vi.mock('@/lib/task-board', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startTaskSession: async (...args: unknown[]) => { calls.log.push(['startTaskSession', ...args]); return calls.started; },
}));

const { openTask, useOpenTaskToast } = await import('./openTask');

const task = { id: 't1', spaceId: 'eml', title: 'phone-close-button', project: 'ui' } as BoardTask;

beforeEach(() => {
  calls.log = [];
  calls.started = 's-new';
  calls.desks = ['d1'];
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
});

const names = () => calls.log.map((c) => c[0]);

describe('opening a task from the desk', () => {
  it('focuses its pane when it is open here', async () => {
    await openTask(task, { kind: 'here', sessionId: 's1', paneId: 'p2', paneNumber: 2 }, { newDesk: false });
    expect(calls.log).toEqual([['activatePane', 'p2']]);
  });

  it('goes to the desk it is open on, never moving it, and Undo comes back', async () => {
    const { result } = renderHook(() => useOpenTaskToast());
    await act(() => openTask(task, { kind: 'desk', sessionId: 's1', paneId: 'p9', deskId: 'd2', deskName: 'Outreach' }, { newDesk: true }));
    expect(calls.log).toEqual([['activatePane', 'p9']]);
    expect(result.current[0]?.text).toBe('Switched to Outreach, where Phone close button is open.');
    act(() => result.current[0]!.action!.run());
    expect(calls.log.slice(1)).toEqual([['activateSpace', 'eml'], ['activateDesk', 'd1'], ['activatePane', 'p1']]);
  });

  it('opens a session that is not open in a new pane here; Undo closes the pane', async () => {
    const { result } = renderHook(() => useOpenTaskToast());
    await act(() => openTask(task, { kind: 'closed', sessionId: 's-old', projectId: 'p-ui', since: null }, { newDesk: false }));
    expect(calls.log[0]).toEqual(['openInPane', { surface: 'terminal', projectId: 'p-ui', sessionId: 's-old' }]);
    act(() => result.current[0]!.action!.run());
    expect(names()).toContain('removePane');
    expect(names()).not.toContain('removeDesk');
  });

  it('starts a session on a task that has none, bound on the host; Undo ends it', async () => {
    const { result } = renderHook(() => useOpenTaskToast());
    await act(() => openTask(task, { kind: 'none' }, { newDesk: false }));
    expect(calls.log[0]).toEqual(['startTaskSession', task, expect.objectContaining({ projectId: 'bp-ui', deskId: 'd1', title: 'Phone close button' })]);
    expect(result.current[0]?.text).toBe('Started a session on Phone close button.');
    act(() => result.current[0]!.action!.run());
    expect(calls.log).toContainEqual(['removePane', 'p-started']);
    expect(fetch).toHaveBeenCalledWith('/api/sessions/s-new/archive', { method: 'POST' });
  });

  it('opens in a new desk named after the task with ⌘↵; Undo removes the desk', async () => {
    const { result } = renderHook(() => useOpenTaskToast());
    await act(() => openTask(task, { kind: 'closed', sessionId: 's-old', projectId: 'p-ui', since: null }, { newDesk: true }));
    expect(calls.log.slice(0, 2)).toEqual([['ensureDeskBySlug', 'task-phone-close-button', { name: 'Phone close button' }], ['activateDesk', 'd-new']]);
    act(() => result.current[0]!.action!.run());
    expect(calls.log).toContainEqual(['removeDesk', 'd-new']);
  });

  it('opens a task of another space on that space\'s desk', async () => {
    await openTask(task, { kind: 'none', otherSpace: { name: 'Atlas', key: null } }, { newDesk: false });
    expect(calls.log[0]).toEqual(['activateSpace', null]);
  });

  it('falls back to a terminal pane on the task when the host cannot start it', async () => {
    calls.started = null;
    await openTask(task, { kind: 'none' }, { newDesk: false });
    expect(calls.log).toContainEqual(['addWorkerPane', expect.objectContaining({ taskId: 't1', projectId: 'bp-ui', deskId: 'd1' })]);
  });
});
