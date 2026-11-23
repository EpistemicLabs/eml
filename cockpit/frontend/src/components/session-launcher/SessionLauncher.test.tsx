// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fx = vi.hoisted(() => ({ started: [] as unknown[], resumed: [] as unknown[] }));

vi.mock('@/stores/usePaneStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDeskOfPane: () => ({ spaceId: null, panes: [] }),
  lastProjectOfDesk: () => 'bp-cs',
  startSessionInPane: (paneId: string, opts: object) => { fx.started.push({ paneId, ...opts }); return 'x'; },
  resumeSessionInPane: (paneId: string, opts: object) => { fx.resumed.push({ paneId, ...opts }); },
}));
vi.mock('@/stores/useSpaceStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSpaces: () => [{ id: 'main', name: 'Main', main: true }],
}));
vi.mock('@/components/sidebar/useAllSessions', () => ({ useAllSessions: () => ({
  sessions: [{ id: 's-ask', __projectId: 'bp-northwind', spaceId: 'main', lastActivity: '2026-11-20T09:00:00Z', summary: 'Northwind: Max reply check', attention: { kind: 'question' } }],
  queued: [], refresh: () => {},
}) }));

import { peekChatStart } from '@/components/chat/chat-start';

import { setLauncherProjects } from './launcher-projects';
import { SessionLauncher } from './SessionLauncher';

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionLauncher paneId="p1" /></QueryClientProvider>);

beforeEach(() => {
  fx.started = []; fx.resumed = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  setLauncherProjects([
    { projectId: 'bp-cs', displayName: 'CS Dashboard Tools', fullPath: '/w/cs' },
    { projectId: 'bp-northwind', displayName: 'Northwind', fullPath: '/w/v' },
  ]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the empty pane\'s launcher', () => {
  it('starts in the desk\'s project, or the one the words name, as a chat with the text as its first message', () => {
    mount();
    const box = screen.getByRole('textbox', { name: 'First message' });
    expect(document.activeElement).toBe(box);
    expect(screen.getByRole('button', { name: 'Project: CS Dashboard Tools (last used on this desk)' })).toBeTruthy();
    fireEvent.change(box, { target: { value: 'Did Northwind answer?' } });
    expect(screen.getByRole('button', { name: 'Project: Northwind (from your words)' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(fx.started).toEqual([expect.objectContaining({ paneId: 'p1', projectId: 'bp-northwind', view: 'chat', prompt: 'Did Northwind answer?' })]);
    const id = (fx.started[0] as { sessionId: string }).sessionId;
    expect(peekChatStart(id)).toEqual({ prompt: 'Did Northwind answer?', model: null });
  });

  it('Shift+Enter is a new line; an empty box starts a plain terminal session; a pick sticks over the words', () => {
    mount();
    const box = screen.getByRole('textbox', { name: 'First message' });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(fx.started).toEqual([]);
    fireEvent.click(within(screen.getByRole('region', { name: 'Recent projects' })).getByRole('button', { name: /^Northwind/ }));
    fireEvent.change(box, { target: { value: 'something about CS Dashboard Tools' } });
    expect(screen.getByRole('button', { name: 'Project: Northwind' })).toBeTruthy();
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(fx.started).toEqual([expect.objectContaining({ projectId: 'bp-northwind', view: 'terminal', prompt: null })]);
  });

  it('continues a session of the space in this pane, marking the ones that ask you something', () => {
    mount();
    const row = screen.getByRole('button', { name: /Northwind: Max reply check/ });
    expect(row.textContent).toContain('waits for you');
    fireEvent.click(row);
    expect(fx.resumed).toEqual([{ paneId: 'p1', projectId: 'bp-northwind', sessionId: 's-ask', chat: false }]);
  });
});
