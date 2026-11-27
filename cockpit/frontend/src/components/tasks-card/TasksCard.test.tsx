// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { Board, BoardTask } from '@/lib/task-board';

const live = vi.hoisted(() => ({
  sessions: [] as unknown[],
  turns: {} as Record<string, unknown>,
  opened: [] as unknown[],
  posts: [] as Array<{ url: string; body: Record<string, unknown> }>,
  startStatus: 202,
  started: [] as unknown[],
  closedAsks: [] as string[],
  told: [] as string[],
  panels: [] as unknown[],
  desk: { id: 'desk-1', name: 'Desk 1', spaceId: null, panes: [] as unknown[], activePaneId: 'p1' },
}));
vi.mock('@/components/sidebar/useAllSessions', () => ({ useAllSessions: () => ({ sessions: live.sessions, queued: [], refresh: () => {} }) }));
vi.mock('@/stores/useTurnStateStore', async (importOriginal) => ({ ...(await importOriginal<object>()), useTurnStore: () => ({ turns: live.turns, seen: {} }) }));
vi.mock('@/stores/useSpaceStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSpaces: () => [{ id: 'main', name: 'Main', main: true, agent: 'atlas', upgrade: null }],
}));
vi.mock('@/stores/usePaneStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useActiveDesk: () => live.desk,
  useActivePane: () => live.desk.panes.find((p) => (p as { id: string }).id === live.desk.activePaneId),
  openSessionInSpace: (key: unknown, target: unknown) => { live.opened.push([key, target]); return 'pane'; },
  addWorkerPane: (opts: unknown) => { live.started.push(opts); return 'pane'; },
}));
vi.mock('@/stores/useTaskViewStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestTaskPanel: (id: string, task: unknown) => { live.panels.push(['panel', id, task]); },
}));
vi.mock('@/stores/useTopViewStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setTopView: (view: string) => { live.panels.push(['view', view]); },
}));
vi.mock('@/components/command-palette/openTask', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  tellOnDesk: (text: string) => { live.told.push(text); },
}));

import { TasksCard } from './TasksCard';

const task = (id: string, patch: Partial<BoardTask> = {}): BoardTask => ({
  id, spaceId: 'main', spaceName: 'Main', project: 'ui', title: id, status: 'active', parentId: null, originId: null, rel: null, updatedAt: null,
  turn: 'needs_you', group: 'own', coverage: { ok: false, group: 'mine' }, urgency: 0, important: false, sessionIds: [], working: false, nextRunAt: null, hasSchedule: false, ...patch,
});
const board = (): Board => ({
  at: '', viewer: 'me',
  spaces: [{ id: 'main', name: 'Main', agents: [] }],
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
  live.turns = {};
  live.started = [];
  live.posts = [];
  live.closedAsks = [];
  live.told = [];
  live.panels = [];
  live.startStatus = 202;
  live.sessions = [
    { id: 's-root', spaceId: 'main', projectId: 'p-ui', summary: 'Session review', taskId: 'session-review-ui' },
    { id: 's-a', spaceId: 'main', projectId: 'p-ui', summary: 'Board v3', taskId: 'task-board-mock' },
    { id: 's-b', spaceId: 'main', projectId: 'p-ui', summary: 'Board v4', taskId: 'task-board-mock' },
  ];
  live.desk = { id: 'desk-1', name: 'Desk 1', spaceId: null, activePaneId: 'p1', panes: [{ id: 'p1', projectId: 'p-ui', sessionId: 's-root', paneView: 'chat' }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/tasks/board') return new Response(JSON.stringify(board()), { status: 200 });
    if (url.startsWith('/api/v1/tasks/closed?')) {
      live.closedAsks.push(url);
      const limit = Number(new URL(url, 'http://x').searchParams.get('limit'));
      const tasks = [{ id: 'old-research', spaceId: 'main', spaceName: 'Main', project: 'ui', title: 'old-research', status: 'resolved', closedAt: '2026-11-20T00:00:00Z', parentId: null, originId: null, sessionIds: [] }];
      return new Response(JSON.stringify({ tasks, more: limit < 40 }), { status: 200 });
    }
    if (url.endsWith('/start')) { live.posts.push({ url, body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ sessionId: 's-x' }), { status: live.startStatus }); }
    return new Response('{}', { status: 404 });
  }));
  try { localStorage.clear(); } catch { /* no storage */ }
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// The card starts with only the desk's trees; most tests look at the whole tree.
async function renderAll() {
  renderCard();
  await screen.findByRole('tree', { name: 'EML UI/UX' });
  fireEvent.click(screen.getByRole('switch', { name: 'All tasks' }));
}

const row = (name: RegExp) => screen.getAllByRole('treeitem').find((el) => name.test(el.getAttribute('aria-label') ?? ''))!;

describe('the tasks card', () => {
  it('says what a session waits for when its own turn is over and its subagents still run', async () => {
    live.sessions = [...live.sessions, { id: 's-free', spaceId: 'main', projectId: 'p-ui', summary: 'Compare the exports' }, { id: 's-busy', spaceId: 'main', projectId: 'p-ui', summary: 'Write the report' }];
    live.desk = { ...live.desk, panes: [...live.desk.panes, { id: 'p2', projectId: 'p-ui', sessionId: 's-free', paneView: 'chat' }, { id: 'p3', projectId: 'p-ui', sessionId: 's-busy', paneView: 'chat' }] };
    live.turns = { 's-free': { state: 'working', since: '2026-02-01T11:00:00.000Z', helpers: 2 }, 's-busy': { state: 'working', since: '2026-02-01T11:00:00.000Z' } };
    await renderAll();
    expect(row(/^Compare the exports, Waiting for 2 subagents/)).toBeTruthy();
    expect(row(/^Write the report, Working/)).toBeTruthy();
  });

  it('says a session waits for a command once its turn is over while one it started runs, in the working hue', async () => {
    live.sessions = [...live.sessions, { id: 's-cmd', spaceId: 'main', projectId: 'p-ui', summary: 'Run the suite', state: 'running' }];
    live.desk = { ...live.desk, panes: [...live.desk.panes, { id: 'p2', projectId: 'p-ui', sessionId: 's-cmd', paneView: 'chat' }] };
    live.turns = { 's-cmd': { state: 'done', since: '2026-02-01T11:00:00.000Z', commands: [{ description: 'Run the tests', since: '2026-02-01T11:00:00.000Z' }] } };
    await renderAll();
    const dot = row(/^Run the suite, Waiting for a command/).querySelector('[aria-hidden].rounded-full');
    expect(dot?.className).toContain('bg-status-agent');
    expect(dot?.className).not.toContain('animate-live');
  });

  it('shows the desk\'s project with its task tree, the active pane\'s row marked', async () => {
    await renderAll();
    expect(row(/^Session review ui, Needs you/).getAttribute('aria-selected')).toBe('true');
    expect(row(/^Media viewer, Parked/).className).toContain('before:border-dashed');
    expect(row(/^Task board mock, Agent working/).getAttribute('aria-expanded')).toBe('true');
    expect(row(/^Board v3, session$/)).toBeTruthy();
    expect(row(/^Session review ui, Needs you/).querySelector('[data-on-desk]')!.className).toContain('text-foreground');
    expect(row(/^Board v3, session$/).querySelector('[data-on-desk]')!.className).toContain('text-muted-foreground');
    expect(row(/^Media viewer, Parked/).querySelector('[data-on-desk]')!.className).toContain('text-muted-foreground');
    expect(row(/^Session review ui, Needs you, session open on this desk/)).toBeTruthy();
  });

  it('focuses or opens a session on click, and starts one on a task without a session', async () => {
    await renderAll();
    fireEvent.click(row(/^Board v4/).querySelector('[data-tree-row]')!);
    expect(live.opened).toEqual([[null, { surface: 'session', projectId: 'p-ui', sessionId: 's-b' }]]);
    fireEvent.click(row(/^Media viewer/).querySelector('[data-tree-row]')!);
    await waitFor(() => expect(live.posts).toHaveLength(1));
    expect(live.posts[0]).toMatchObject({ url: '/api/v1/tasks/media-viewer/start', body: { spaceId: 'main', projectId: 'bp-ui', deskId: 'desk-1' } });
    expect(live.started).toEqual([]);
  });

  it('falls back to a terminal pane on the task when the host cannot start it', async () => {
    live.startStatus = 404;
    await renderAll();
    fireEvent.click(row(/^Media viewer/).querySelector('[data-tree-row]')!);
    await waitFor(() => expect(live.started).toEqual([expect.objectContaining({ taskId: 'media-viewer', projectId: 'bp-ui', deskId: 'desk-1', fromSessionId: null })]));
  });

  it('folds a branch and remembers it for the desk', async () => {
    await renderAll();
    fireEvent.click(row(/^Task board mock/).querySelector('[data-tree-toggle]')!);
    expect(row(/^Task board mock/).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Board v3')).toBeNull();
    cleanup();
    renderCard();
    await screen.findByRole('tree', { name: 'EML UI/UX' });
    expect(row(/^Task board mock/).getAttribute('aria-expanded')).toBe('false');
  });

  it('shows only the desk\'s trees until All tasks is on, then every open task and no more-link', async () => {
    renderCard();
    await screen.findByRole('tree', { name: 'EML UI/UX' });
    expect(screen.queryByText('Board v3')).toBeNull();
    expect(screen.getByRole('button', { name: '2 more open tasks in EML UI/UX' })).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'All tasks' }));
    expect(screen.getByText('Board v3')).toBeTruthy();
    expect(row(/^Media viewer, Parked/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /more open task/ })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'All sessions' })).toBeNull();
  });

  it('keeps Show done and All tasks per desk', async () => {
    await renderAll();
    fireEvent.click(screen.getByRole('switch', { name: 'Show done' }));
    cleanup();
    renderCard();
    await screen.findByRole('tree', { name: 'EML UI/UX' });
    expect(screen.getByRole('switch', { name: 'All tasks' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Show done' }).getAttribute('aria-checked')).toBe('true');
    cleanup();
    live.desk = { ...live.desk, id: 'desk-2', name: 'Desk 2' };
    renderCard();
    await screen.findByRole('tree', { name: 'EML UI/UX' });
    expect(screen.getByRole('switch', { name: 'All tasks' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('switch', { name: 'Show done' }).getAttribute('aria-checked')).toBe('false');
  });

  it('with Show done, loads the project\'s closed tasks, opens a closed one\'s panel to reopen it, and asks for older ones', async () => {
    renderCard();
    await screen.findByRole('tree', { name: 'EML UI/UX' });
    expect(live.closedAsks).toEqual([]);
    fireEvent.click(screen.getByRole('switch', { name: 'Show done' }));
    await waitFor(() => expect(row(/^Old research, Done/)).toBeTruthy());
    expect(live.closedAsks).toEqual(['/api/v1/tasks/closed?spaceId=main&project=ui&limit=20']);
    fireEvent.click(row(/^Old research/).querySelector('[data-tree-row]')!);
    expect(live.panels).toEqual([['panel', 'old-research', expect.objectContaining({ id: 'old-research', status: 'resolved', turn: null })], ['view', 'tasks']]);
    expect(live.posts).toEqual([]);
    expect(live.told).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Show older in EML UI/UX' }));
    await waitFor(() => expect(live.closedAsks.at(-1)).toBe('/api/v1/tasks/closed?spaceId=main&project=ui&limit=40'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show older in EML UI/UX' })).toBeNull());
  });

  it('opens the task search from Open task…', async () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('cockpit:task-search', listener);
    renderCard();
    await screen.findByRole('tree', { name: 'EML UI/UX' });
    fireEvent.click(screen.getByRole('button', { name: /Open task…/ }));
    window.removeEventListener('cockpit:task-search', listener);
    expect(seen).toEqual([{ project: null }]);
  });
});
