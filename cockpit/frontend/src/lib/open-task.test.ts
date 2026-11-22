import { describe, expect, it } from 'vitest';

import type { Board, BoardTask } from '@/lib/task-board';

import { locateTask, locationWords, searchTasks, type LocateContext } from './open-task';

const task = (id: string, patch: Partial<BoardTask> = {}): BoardTask => ({
  id, spaceId: 'eml', spaceName: 'EML', project: 'ui', title: id, status: 'active', parentId: null, updatedAt: '2026-11-20T10:00:00Z',
  turn: 'waiting_on_others', coverage: { ok: true, how: 'working' }, urgency: 0, important: false, onBoard: false, sessionIds: [], working: false, nextRunAt: null, ...patch,
});

const ctx = (patch: Partial<LocateContext> = {}): LocateContext => ({
  activeDeskId: 'd1',
  desks: [
    { id: 'd1', name: 'Desk 1', spaceId: 'eml', panes: [{ id: 'p1', sessionId: 's-here' }, { id: 'p2', sessionId: 's-other-pane' }] },
    { id: 'd2', name: 'Outreach', spaceId: 'eml', panes: [{ id: 'p3', sessionId: 's-there' }] },
  ],
  sessions: [
    { id: 's-closed', lastActivity: '2026-11-21T09:00:00Z', projectId: 'p-ui' },
    { id: 's-older', lastActivity: '2026-11-19T09:00:00Z', projectId: 'p-ui' },
  ],
  spaces: [{ id: 'eml', name: 'EML', key: 'eml' }, { id: 'main', name: 'Atlas', key: null }],
  activeSpaceKey: 'eml',
  ...patch,
});

describe('where a task is now', () => {
  it('is open here when one of its sessions is in a pane of this desk', () => {
    const where = locateTask(task('t', { sessionIds: ['s-there', 's-other-pane'] }), ctx());
    expect(where).toMatchObject({ kind: 'here', sessionId: 's-other-pane', paneId: 'p2', paneNumber: 2 });
    expect(locationWords(where)).toEqual({ text: 'Open here · pane 2', act: 'Go to pane' });
  });

  it('is open on another desk, which Enter goes to (the session is never moved)', () => {
    const where = locateTask(task('t', { sessionIds: ['s-there'] }), ctx());
    expect(where).toMatchObject({ kind: 'desk', deskId: 'd2', paneId: 'p3' });
    expect(locationWords(where)).toEqual({ text: 'Open on Outreach', act: 'Go to Outreach' });
  });

  it('has a session that is not open: the newest one opens here', () => {
    const where = locateTask(task('t', { sessionIds: ['s-older', 's-closed'] }), ctx());
    expect(where).toMatchObject({ kind: 'closed', sessionId: 's-closed', projectId: 'p-ui' });
    expect(locationWords(where)).toEqual({ text: 'Session from 21 Nov, not open', act: 'Open here' });
  });

  it('has no session yet: Enter starts one on it', () => {
    expect(locationWords(locateTask(task('t'), ctx()))).toEqual({ text: 'No session yet', act: 'Start a session here' });
  });

  it('lives in another space: it opens on that space\'s desk', () => {
    const where = locateTask(task('t', { spaceId: 'main', spaceName: 'Atlas' }), ctx());
    expect(where).toMatchObject({ kind: 'none', otherSpace: { name: 'Atlas', key: null } });
    expect(locationWords(where)).toEqual({ text: 'In the Atlas space · no session yet', act: 'Start in Atlas' });
  });
});

describe('searching open tasks', () => {
  const board = {
    tasks: [
      task('northwind-cancellation-rescue', { project: 'northwind', turn: 'needs_you', updatedAt: '2026-11-18T10:00:00Z' }),
      task('phone-close-button', { turn: 'review', updatedAt: '2026-11-21T10:00:00Z' }),
      task('cockpit-media-viewer', { status: 'planned', turn: null }),
      task('old-done', { status: 'resolved', turn: 'done' }),
    ],
    projects: [{ spaceId: 'eml', id: 'northwind', name: 'Northwind GmbH', goal: null }, { spaceId: 'eml', id: 'ui', name: 'EML UI/UX', goal: null }],
  } as unknown as Board;

  it('shows what needs you first when nothing is typed, then the other open tasks', () => {
    const groups = searchTasks(board, '');
    expect(groups.map((g) => [g.name, g.tasks.map((t) => t.id)])).toEqual([
      ['Needs you', ['phone-close-button', 'northwind-cancellation-rescue']],
      ['Other open tasks', ['cockpit-media-viewer']],
    ]);
  });

  it('finds tasks by title words, customer or project name, and anchor', () => {
    expect(searchTasks(board, 'phone close')[0].tasks.map((t) => t.id)).toEqual(['phone-close-button']);
    expect(searchTasks(board, 'northwind gmbh')[0].tasks.map((t) => t.id)).toEqual(['northwind-cancellation-rescue']);
    expect(searchTasks(board, 'cockpit-media')[0].tasks.map((t) => t.id)).toEqual(['cockpit-media-viewer']);
    expect(searchTasks(board, 'nothing like this')).toEqual([]);
  });

  it('keeps to one project when asked (the tasks card\'s more link)', () => {
    expect(searchTasks(board, '', { project: 'northwind' }).flatMap((g) => g.tasks.map((t) => t.id))).toEqual(['northwind-cancellation-rescue']);
  });
});
