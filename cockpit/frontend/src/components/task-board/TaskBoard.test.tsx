// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

import type { Board, BoardTask } from '@/lib/task-board';

const live = vi.hoisted(() => ({ sessions: [] as unknown[], seen: [] as string[][] }));
vi.mock('@/components/sidebar/useAllSessions', () => ({ useAllSessions: () => ({ sessions: live.sessions, queued: [], refresh: () => {} }) }));
vi.mock('@/components/ui/session-chat', () => ({ SessionChat: ({ sessionId }: { sessionId: string }) => <div data-testid="session-chat">{sessionId}</div> }));
vi.mock('@/stores/useTurnStateStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTurnStore: () => ({ turns: { s1: { state: 'done', since: 'x' } }, seen: {} }),
  markSeen: (ids: string[]) => { live.seen.push(ids); },
}));
vi.mock('@/lib/queries', () => ({ useEngram: () => ({ data: undefined }) }));

import { resetTaskBoardPage } from '@/stores/useTaskBoardPageStore';
import { setTaskView } from '@/stores/useTaskViewStore';
import { DEFAULT_TASK_FILTER, setTaskFilter } from '@/stores/useTaskFilterStore';
import { TaskNav } from '@/components/sidebar/nav/SidebarNav';
import { useCockpitShortcuts } from '@/components/top-bar/useCockpitShortcuts';

import { TaskBoard } from './TaskBoard';

const NOW = new Date();
const iso = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const task = (patch: Partial<BoardTask>): BoardTask => ({
  id: 't', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'task', status: 'active', parentId: null, updatedAt: iso(30),
  turn: 'needs_you', group: 'own', coverage: { ok: false, group: 'mine' }, urgency: 0, important: false, sessionIds: [], working: false, nextRunAt: null, owner: 'lasse', ...patch,
});
const board = (): Board => ({
  at: NOW.toISOString(), viewer: 'lasse',
  spaces: [{ id: 'main', name: 'Main', agents: ['atlas'] }, { id: 'ebisu', name: 'Ebisu', agents: [] }],
  projects: [{ spaceId: 'main', id: 'acme', name: 'Acme', goal: null }],
  tasks: [
    task({ id: 'asked', title: 'acme-cancellation-rescue', group: 'asked', delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'question', why: 'One last check on Thursday?', since: iso(5) } }),
    task({ id: 'mine', title: 'demo-meeting-prep' }),
    task({ id: 'running', title: 'kit-v4-rollout', turn: 'agent_working', group: undefined, delegate: 'atlas', working: true }),
    task({ id: 'theirs', title: 'dominik-release-notes', owner: 'dominik' }),
    task({ id: 'ebisu', title: 'ebisu-onboarding', spaceId: 'ebisu', spaceName: 'Ebisu', project: null }),
  ],
  inbox: [{ key: 'task:asked@x', kind: 'question', space: 'main', title: 'acme-cancellation-rescue', text: 'One last check on Thursday?', since: iso(5), taskId: 'asked' }],
  snoozed: [], events: [], counts: { needsYou: 2, inbox: 1 },
});

let posts: Array<{ url: string; body: Record<string, unknown> }>;
beforeEach(() => {
  posts = [];
  live.sessions = [];
  live.seen = [];
  setTaskView('now');
  resetTaskBoardPage();
  setTaskFilter(DEFAULT_TASK_FILTER);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/tasks/board') return new Response(JSON.stringify(board()), { status: 200 });
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.includes('/undo')) return new Response(JSON.stringify({ state: 'undone' }), { status: 200 });
      return new Response(JSON.stringify({ opId: 'op-1', state: 'pending', undoUntil: new Date(Date.now() + 8000).toISOString(), carriedQuestion: url.includes('/asked/') ? 'One last check on Thursday?' : undefined }), { status: 202 });
    }
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// The board with the sidebar's task views and the app's shortcuts, as the cockpit mounts them.
function WithBar() {
  useCockpitShortcuts(() => {});
  return <><TaskNav /><TaskBoard /></>;
}
const mount = () => render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><WithBar /></QueryClientProvider></MemoryRouter>);

describe('the task board', () => {
  it('sorts cards by whose turn it is', async () => {
    mount();
    const needsYou = await screen.findByRole('region', { name: 'Needs you' });
    expect(within(needsYou).getByText('Acme cancellation rescue')).toBeTruthy();
    expect(within(needsYou).getByText('Asked you · 1')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Agent working' })).getByText('Kit v4 rollout')).toBeTruthy();
  });

  it('follows the view picked in the sidebar or with G then I / N / P; the Inbox row shows its count; bare digits do nothing', async () => {
    mount();
    await screen.findByRole('region', { name: 'Needs you' });
    expect((await screen.findByRole('button', { name: /^Inbox/ })).textContent).toContain('1');
    fireEvent.click(screen.getByRole('button', { name: /^Plan/ }));
    expect(await screen.findByText(/Stuck until you act/)).toBeTruthy();
    fireEvent.keyDown(document, { key: '2' });
    expect(screen.getByText(/Stuck until you act/)).toBeTruthy();
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'i' });
    expect(await screen.findByText(/One last check on Thursday\?/)).toBeTruthy();
  });

  it('narrows every Now column and its count by Owner and Space, and keeps the pick across views', async () => {
    mount();
    const needsYou = () => screen.getByRole('region', { name: 'Needs you' });
    await screen.findByRole('region', { name: 'Needs you' });
    expect(within(needsYou()).queryByText('Dominik release notes')).toBeNull();
    expect(within(needsYou()).getByText('3')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Owner' })).getByRole('button', { name: 'Everyone' }));
    expect(within(needsYou()).getByText('Dominik release notes')).toBeTruthy();
    expect(within(needsYou()).getByText('4')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Space' })).getByRole('button', { name: 'Ebisu' }));
    expect(within(needsYou()).getByText('1')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Agent working' })).queryByText('Kit v4 rollout')).toBeNull();
    // Away to the Inbox and Plan and back: the picks are still set, on Plan too.
    fireEvent.click(screen.getByRole('button', { name: /^Inbox/ }));
    await screen.findByText(/One last check on Thursday\?/);
    fireEvent.click(screen.getByRole('button', { name: /^Plan/ }));
    await screen.findByText(/Stuck until you act/);
    expect(within(screen.getByRole('group', { name: 'Space' })).getByRole('button', { name: 'Ebisu' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(screen.getByRole('group', { name: 'Owner' })).getByRole('button', { name: 'Everyone' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /^Now/ }));
    expect(within(await screen.findByRole('region', { name: 'Needs you' })).getByText('Ebisu onboarding')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Space' })).getByRole('button', { name: 'Ebisu' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows All when the remembered space is gone, on Now and Plan', async () => {
    setTaskFilter({ spaceId: 'gone' });
    mount();
    const space = () => within(screen.getByRole('group', { name: 'Space' }));
    expect(within(await screen.findByRole('region', { name: 'Needs you' })).getByText('Acme cancellation rescue')).toBeTruthy();
    expect(space().getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /^Plan/ }));
    await screen.findByText(/Stuck until you act/);
    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
    expect(space().getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('opens a card as a slide-over with focus on its title, answering first; Escape closes it', async () => {
    mount();
    fireEvent.click(await screen.findByText('Acme cancellation rescue'));
    const sheet = await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement?.id).toBe('task-board-title'));
    expect(within(sheet).getByText('Needs you · Atlas asks')).toBeTruthy();
    // No session on it in this fixture: the box says how to answer instead of offering Reply.
    expect(within(sheet).getByText(/Its session is gone/)).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes with the pane toolbar\'s ×, like a desk pane', async () => {
    mount();
    fireEvent.click(await screen.findByText('Acme cancellation rescue'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).queryByText(/Esc closes/)).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close this pane' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('hands over with the open question carried, and offers Undo', async () => {
    mount();
    fireEvent.click(await screen.findByText('Acme cancellation rescue'));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getAllByRole('button', { name: 'Run Atlas now' })[0]);
    const dialog = await screen.findByText(/asked you something that is still open/);
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to Atlas anyway' }));
    await waitFor(() => expect(posts[0]?.url).toBe('/api/v1/tasks/asked/hand-over'));
    expect(posts[0].body).toMatchObject({ spaceId: 'main', mode: 'now', delegate: 'atlas', checkpoint: 'after' });
    const status = await screen.findByRole('status');
    await waitFor(() => expect(status.textContent).toContain('The open question went with it.'));
    await act(async () => { fireEvent.click(within(status).getByRole('button', { name: 'Undo' })); });
    await waitFor(() => expect(posts.at(-1)?.url).toBe('/api/v1/commands/op-1/undo'));
  });

  it('offers to hand a task to the agent Work on it now released, with that agent chosen', async () => {
    const released = (): Board => ({
      ...board(),
      spaces: [{ id: 'main', name: 'Main', agents: ['motti', 'atlas'] }, { id: 'ebisu', name: 'Ebisu', agents: [] }],
      tasks: board().tasks.map((t) => (t.id === 'mine' ? { ...t, handTo: 'atlas' } : t)),
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/tasks/board') return new Response(JSON.stringify(released()), { status: 200 });
      if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ opId: 'op-1', state: 'pending', undoUntil: new Date(Date.now() + 8000).toISOString() }), { status: 202 });
    }));
    mount();
    fireEvent.click(await screen.findByText('Demo meeting prep'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).queryByRole('button', { name: 'Delegate now' })).toBeNull();
    fireEvent.click(within(sheet).getAllByRole('button', { name: 'Hand to Atlas' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Delegate to Atlas' }));
    await waitFor(() => expect(posts[0]?.url).toBe('/api/v1/tasks/mine/hand-over'));
    expect(posts[0].body).toMatchObject({ mode: 'now', delegate: 'atlas' });
  });

  it('snoozes an Inbox item to tomorrow 09:00', async () => {
    setTaskView('inbox');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Snooze to tomorrow' }));
    await waitFor(() => expect(posts[0]?.url).toBe('/api/v1/tasks/asked/snooze'));
    const until = new Date(String(posts[0].body.until));
    expect([until.getHours(), until.getMinutes()]).toEqual([9, 0]);
    expect(posts[0].body.key).toBe('task:asked@x');
  });

  it('counts a session shown in the task panel as seen, as on its desk', async () => {
    live.sessions = [{ id: 's1', spaceId: 'main', __projectId: 'acme', lastActivity: iso(1) }];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/v1/tasks/board') return new Response(JSON.stringify({ ...board(), tasks: board().tasks.map((t) => (t.id === 'mine' ? { ...t, sessionIds: ['s1'] } : t)) }), { status: 200 });
      return new Response('{}', { status: 404 });
    }));
    mount();
    fireEvent.click(await screen.findByText('Demo meeting prep'));
    expect(await screen.findByTestId('session-chat')).toBeTruthy();
    expect(live.seen).toContainEqual(['s1']);
  });

  it('closes a task that is not needed from its project in Plan, with Undo', async () => {
    setTaskView('plan');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Acme/, expanded: false }));
    const closers = screen.getAllByTitle('Close: the task is not needed');
    expect(closers).toHaveLength(3);
    fireEvent.click(closers[0]);
    await waitFor(() => expect(posts[0]?.url).toMatch(/^\/api\/v1\/tasks\/(asked|mine|running)\/close$/));
    expect(posts[0].body).toMatchObject({ spaceId: 'main' });
    const status = await screen.findByRole('status');
    await waitFor(() => expect(status.textContent).toContain('Closed: not needed.'));
    await act(async () => { fireEvent.click(within(status).getByRole('button', { name: 'Undo' })); });
    await waitFor(() => expect(posts.at(-1)?.url).toBe('/api/v1/commands/op-1/undo'));
  });
});

describe('the Unread fold', () => {
  const answer = (id: string, minutesAgo: number, fields: Record<string, unknown> = {}) => ({
    id, spaceId: 'main', __projectId: 'bp-acme', state: 'ended', summary: `Session ${id}`, createdAt: iso(90), lastActivity: iso(minutesAgo),
    attention: { kind: 'done', reason: `Answer of ${id}`, at: iso(minutesAgo) }, readAt: null, resultAt: null, ...fields,
  });
  const withBoard = (patch: Partial<Board>) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/tasks/board') return new Response(JSON.stringify({ ...board(), ...patch }), { status: 200 });
      if (init?.method === 'POST') { posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : {} }); return new Response('{}', { status: 200 }); }
      return new Response('{}', { status: 404 });
    }));
  };
  const navDot = () => screen.queryByRole('img', { name: /unread answers?, nothing to do/ });

  it('is folded while the Inbox has items, and the Inbox count stays the actionable ones', async () => {
    live.sessions = [answer('s2', 3), answer('s3', 10)];
    withBoard({});
    setTaskView('inbox');
    mount();
    const toggle = await screen.findByRole('button', { name: 'Show unread answers', expanded: false });
    expect(screen.getByText(/Unread · 2/)).toBeTruthy();
    expect(screen.queryByText('Answer of s2')).toBeNull();
    expect(screen.getByLabelText('1 waiting for you').textContent).toBe('1');
    expect(navDot()).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.getByText('Answer of s2')).toBeTruthy();
  });

  it('opens by itself when nothing needs you, and leaves out a session the Inbox lists', async () => {
    live.sessions = [answer('s2', 3), answer('listed', 4, { taskId: 'asked' })];
    withBoard({ inbox: [], snoozed: [{ key: 'task:asked@x', kind: 'question', space: 'main', title: 'acme-cancellation-rescue', text: '', since: iso(5), taskId: 'asked', until: iso(-600) }], counts: { needsYou: 0, inbox: 0 } });
    setTaskView('inbox');
    mount();
    expect(await screen.findByText('Nothing needs you')).toBeTruthy();
    expect(screen.getByText(/1 session answered since you last looked\./)).toBeTruthy();
    expect(screen.getByText('Answer of s2')).toBeTruthy();
    expect(screen.queryByText('Answer of listed')).toBeNull();
    expect(screen.getByText('no task')).toBeTruthy();
  });

  it('opening a row reads it: the row leaves and the host is told', async () => {
    live.sessions = [answer('s2', 3), answer('s3', 10)];
    withBoard({ inbox: [], counts: { needsYou: 0, inbox: 0 } });
    setTaskView('inbox');
    mount();
    fireEvent.click(await screen.findByText('Answer of s2'));
    await waitFor(() => expect(posts.map((p) => p.url)).toContain('/api/sessions/s2/read'));
    expect(screen.queryByText('Answer of s2')).toBeNull();
    expect(screen.getByText(/Unread · 1/)).toBeTruthy();
  });

  it('a row without a task opens beside the list with its chat, not on its desk', async () => {
    live.sessions = [answer('s2', 3), answer('s3', 10)];
    withBoard({ inbox: [], counts: { needsYou: 0, inbox: 0 } });
    setTaskView('inbox');
    mount();
    fireEvent.click(await screen.findByText('Answer of s2'));
    expect((await screen.findByTestId('session-chat')).textContent).toBe('s2');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Session s2');
    expect(screen.getByText('Answer of s3')).toBeTruthy();
    expect(live.seen).toContainEqual(['s2']);
  });

  it('leaving the board and coming back finds the fold and the open session as they were', async () => {
    live.sessions = [answer('s2', 3), answer('s3', 10)];
    withBoard({});
    setTaskView('inbox');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Show unread answers', expanded: false }));
    fireEvent.click(screen.getByText('Answer of s2'));
    expect((await screen.findByTestId('session-chat')).textContent).toBe('s2');
    cleanup();
    mount();
    expect((await screen.findByTestId('session-chat')).textContent).toBe('s2');
    expect(screen.getByRole('button', { name: 'Hide unread answers', expanded: true })).toBeTruthy();
  });

  it('Mark all read empties it, and Undo puts back what each session had', async () => {
    const result = iso(10);
    live.sessions = [answer('s2', 3), answer('s3', 10, { attention: null, resultAt: result })];
    withBoard({ inbox: [], counts: { needsYou: 0, inbox: 0 } });
    setTaskView('inbox');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(posts.map((p) => p.url).sort()).toEqual(['/api/sessions/s2/read', '/api/sessions/s3/read']));
    expect(screen.queryByText(/Unread ·/)).toBeNull();
    const status = await screen.findByRole('status');
    await waitFor(() => expect(status.textContent).toContain('2 marked read.'));
    await act(async () => { fireEvent.click(within(status).getByRole('button', { name: 'Undo' })); });
    await waitFor(() => expect(posts.filter((p) => p.url.endsWith('/unread'))).toHaveLength(2));
    expect(posts.find((p) => p.url === '/api/sessions/s3/unread')?.body).toEqual({ id: 's3', readAt: null, resultAt: result });
    expect(await screen.findByText(/Unread · 2/)).toBeTruthy();
  });

  it('on a phone the Inbox tab shows the grey dot, not a number, for unread answers', async () => {
    const media = (query: string) => ({ matches: !query.includes('pointer'), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} });
    vi.stubGlobal('matchMedia', media);
    window.matchMedia = media as never;
    try {
      live.sessions = [answer('s2', 3)];
      withBoard({ inbox: [], counts: { needsYou: 0, inbox: 0 } });
      setTaskView('inbox');
      mount();
      const tab = await screen.findByRole('tab', { name: /Inbox/ });
      expect(within(tab).getByRole('img', { name: '1 unread answer, nothing to do' })).toBeTruthy();
      expect(tab.textContent).toBe('Inbox');
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });
});
