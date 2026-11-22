// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { Board, BoardTask } from '@/lib/task-board';

const live = vi.hoisted(() => ({
  sessions: [] as unknown[],
  opened: [] as unknown[],
  started: [] as unknown[],
  desk: { id: 'desk-1', name: 'Desk 1', spaceId: null, panes: [] as unknown[], activePaneId: 'p1' },
}));
vi.mock('@/components/sidebar/useAllSessions', () => ({ useAllSessions: () => ({ sessions: live.sessions, queued: [], refresh: () => {} }) }));
vi.mock('@/stores/useTurnStateStore', async (importOriginal) => ({ ...(await importOriginal<object>()), useTurnStore: () => ({ turns: {}, seen: {} }) }));
vi.mock('@/stores/useSpaceStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSpaces: () => [{ id: 'main', name: 'Main', main: true, agent: 'atlas', upgrade: null }],
}));
vi.mock('@/stores/usePaneStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useActiveDesk: () => live.desk,
  useActivePane: () => live.desk.panes.find((p) => (p as { id: string }).id === live.desk.activePaneId),
  getSessionView: () => undefined,
  openSessionInSpace: (key: unknown, target: unknown) => { live.opened.push([key, target]); return 'pane'; },
  addWorkerPane: (opts: unknown) => { live.started.push(opts); return 'pane'; },
}));

import { TasksCard } from './TasksCard';

const task = (id: string, patch: Partial<BoardTask> = {}): BoardTask => ({
  id, spaceId: 'main', spaceName: 'Main', project: 'ui', title: id, status: 'active', parentId: null, originId: null, rel: null, updatedAt: null,
  turn: 'needs_you', group: 'own', coverage: { ok: false, group: 'mine' }, urgency: 0, important: false, onBoard: true, sessionIds: [], working: false, nextRunAt: null, ...patch,
});
const board = (): Board => ({
  at: '', viewer: 'me',
  spaces: [{ id: 'main', name: 'Main', taskSystem: true, agents: [] }],
  projects: [{ spaceId: 'main', id: 'ui', name: 'EML UI/UX', goal: null }],
  tasks: [
    task('session-review-ui', { sessionIds: ['s-root'] }),
    task('media-viewer', { originId: 'session-review-ui', rel: 'spun', turn: null, status: 'planned' }),
    task('task-board-mock', { parentId: 'session-review-ui', rel: 'sub', turn: 'agent_working', sessionIds: ['s-a', 's-b'] }),
  ],
  lineage: [],
  inbox: [], snoozed: [], events: [], counts: { needsYou: 0, inbox: 0 },
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><TasksCard projects={{}} /></QueryClientProvider>);
}

beforeEach(() => {
  live.opened = [];
  live.started = [];
  live.sessions = [
    { id: 's-root', spaceId: 'main', projectId: 'p-ui', summary: 'Session review', taskId: 'session-review-ui' },
    { id: 's-a', spaceId: 'main', projectId: 'p-ui', summary: 'Board v3', taskId: 'task-board-mock' },
    { id: 's-b', spaceId: 'main', projectId: 'p-ui', summary: 'Board v4', taskId: 'task-board-mock' },
  ];
  live.desk = { id: 'desk-1', name: 'Desk 1', spaceId: null, activePaneId: 'p1', panes: [{ id: 'p1', projectId: 'p-ui', sessionId: 's-root', paneView: 'chat' }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/v1/tasks/board' ? new Response(JSON.stringify(board()), { status: 200 }) : new Response('{}', { status: 404 }))));
  try { localStorage.clear(); } catch { /* no storage */ }
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const row = (name: RegExp) => screen.getAllByRole('treeitem').find((el) => name.test(el.getAttribute('aria-label') ?? ''))!;

describe('the tasks card', () => {
  it('shows the desk\'s project with its task tree, the active pane\'s row marked', async () => {
    renderCard();
    expect(await screen.findByRole('tree', { name: 'EML UI/UX' })).toBeTruthy();
    expect(row(/^Session review ui, Needs you/).getAttribute('aria-selected')).toBe('true');
    expect(row(/^Media viewer, Parked/).className).toContain('before:border-dashed');
    expect(row(/^Task board mock, Agent working/).getAttribute('aria-expanded')).toBe('true');
    expect(row(/^Board v3, terminal session/)).toBeTruthy();
  });

  it('focuses or opens a session on click, and starts one on a task without a session', async () => {
    renderCard();
    await screen.findByRole('tree', { name: 'EML UI/UX' });
    fireEvent.click(row(/^Board v4/).querySelector('[data-tree-row]')!);
    expect(live.opened).toEqual([[null, { surface: 'terminal', projectId: 'p-ui', sessionId: 's-b', chat: false }]]);
    fireEvent.click(row(/^Media viewer/).querySelector('[data-tree-row]')!);
    expect(live.started).toEqual([expect.objectContaining({ taskId: 'media-viewer', projectId: 'bp-ui', deskId: 'desk-1', fromSessionId: null })]);
  });

  it('folds a branch and remembers it for the desk', async () => {
    renderCard();
    await screen.findByRole('tree', { name: 'EML UI/UX' });
    fireEvent.click(row(/^Task board mock/).querySelector('[data-tree-toggle]')!);
    expect(row(/^Task board mock/).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Board v3')).toBeNull();
    cleanup();
    renderCard();
    await screen.findByRole('tree', { name: 'EML UI/UX' });
    expect(row(/^Task board mock/).getAttribute('aria-expanded')).toBe('false');
  });

  it('lists only the desk\'s sessions when All sessions is off', async () => {
    renderCard();
    await screen.findByRole('tree', { name: 'EML UI/UX' });
    fireEvent.click(screen.getByRole('switch', { name: 'Show sessions not open on this desk' }));
    expect(screen.queryByText('Board v3')).toBeNull();
  });
});
