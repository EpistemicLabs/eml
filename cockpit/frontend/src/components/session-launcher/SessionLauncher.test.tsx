// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fx = vi.hoisted(() => ({ started: [] as unknown[], resumed: [] as unknown[], providers: [] as unknown[], models: [] as unknown[], fallback: false }));

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

const yes = { supported: true };
const agent = (id: string, label: string, over: object = {}) => ({
  id, label, version: '1.0.0', problem: null, signedIn: true, isDefault: false,
  capabilities: { chat: yes, endTurnTool: yes, messaging: yes }, ...over,
});

beforeEach(() => {
  fx.started = []; fx.resumed = []; fx.fallback = false;
  fx.providers = [
    agent('claude', 'Claude Code', { isDefault: true }),
    agent('codex', 'Codex'),
    agent('qwen', 'Qwen Code', { capabilities: { chat: { supported: false, reason: 'Terminal only.' }, endTurnTool: yes, messaging: yes } }),
  ];
  fx.models = [
    { id: 'claude', models: [{ id: 'opus', label: 'Opus 5.5', description: '', resolved: null }] },
    { id: 'codex', models: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna', description: '', resolved: null }] },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/providers') return new Response(JSON.stringify({ providers: fx.providers }));
    if (url === '/api/providers/models') return new Response(JSON.stringify({ providers: fx.models }));
    if (url === '/api/terminal-fallback') return new Response(JSON.stringify({ enabled: fx.fallback }));
    return new Response('{}', { status: 404 });
  }));
  setLauncherProjects([
    { projectId: 'bp-cs', displayName: 'CS Dashboard Tools', fullPath: '/w/cs' },
    { projectId: 'bp-northwind', displayName: 'Northwind', fullPath: '/w/v' },
  ]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the empty pane\'s launcher', () => {
  it('starts in the desk\'s project, or the one the words name, as a chat of the default agent with the text as its first message', async () => {
    mount();
    await screen.findByRole('combobox', { name: 'Agent and model' });
    const box = screen.getByRole('textbox', { name: 'First message' });
    expect(document.activeElement).toBe(box);
    expect(screen.getByRole('button', { name: 'Project: CS Dashboard Tools (last used on this desk)' })).toBeTruthy();
    fireEvent.change(box, { target: { value: 'Did Northwind answer?' } });
    expect(screen.getByRole('button', { name: 'Project: Northwind (from your words)' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(fx.started).toEqual([expect.objectContaining({ paneId: 'p1', projectId: 'bp-northwind', provider: 'claude' })]);
    expect(fx.started[0]).not.toHaveProperty('terminalFallback');
    const id = (fx.started[0] as { sessionId: string }).sessionId;
    expect(peekChatStart(id)).toEqual({ provider: 'claude', prompt: 'Did Northwind answer?', model: null });
  });

  it('offers the agents the host reports with a chat, grouped with their models, and starts the one picked', async () => {
    fx.providers.push(agent('newcomer', 'Newcomer CLI'));
    mount();
    const picker = await screen.findByRole('combobox', { name: 'Agent and model' }) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Claude Code · default model', 'Claude Code · Opus 5.5', 'Codex · default model', 'Codex · GPT-6 Luna', 'Newcomer CLI · default model',
    ]));
    expect(picker.selectedOptions[0].textContent).toBe('Claude Code · default model');
    expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull();
    const luna = within(picker).getByRole('option', { name: 'Codex · GPT-6 Luna' }) as HTMLOptionElement;
    fireEvent.change(picker, { target: { value: luna.value } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'First message' }), { key: 'Enter' });
    expect(fx.started).toEqual([expect.objectContaining({ provider: 'codex' })]);
    expect(peekChatStart((fx.started[0] as { sessionId: string }).sessionId)).toEqual({ provider: 'codex', prompt: null, model: 'gpt-6-luna' });
  });

  it('without any agent that has a chat, starts nothing and says so; only the terminal fallback could', async () => {
    fx.providers = [agent('qwen', 'Qwen Code', { isDefault: true, capabilities: { chat: { supported: false, reason: 'Terminal only.' }, endTurnTool: yes, messaging: yes } })];
    mount();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toContain('/api/terminal-fallback'));
    // The answer is in: a Qwen Code that has no chat is still not offered.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('combobox', { name: 'Agent and model' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'First message' }), { key: 'Enter' });
    expect(fx.started).toEqual([]);
    expect(screen.getByRole('alert').textContent).toMatch(/No agent with a chat/);
  });

  it('with the terminal fallback on, starts an agent without a chat in the fallback terminal', async () => {
    fx.fallback = true;
    fx.providers = [agent('qwen', 'Qwen Code', { isDefault: true, capabilities: { chat: { supported: false, reason: 'Terminal only.' }, endTurnTool: yes, messaging: yes } })];
    mount();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toContain('/api/terminal-fallback'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'First message' }), { key: 'Enter' });
    expect(fx.started).toEqual([expect.objectContaining({ provider: 'qwen', terminalFallback: true })]);
  });

  it('Shift+Enter is a new line; a pick sticks over the words', async () => {
    mount();
    await screen.findByRole('combobox', { name: 'Agent and model' });
    const box = screen.getByRole('textbox', { name: 'First message' });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(fx.started).toEqual([]);
    fireEvent.click(within(screen.getByRole('region', { name: 'Recent projects' })).getByRole('button', { name: /^Northwind/ }));
    fireEvent.change(box, { target: { value: 'something about CS Dashboard Tools' } });
    expect(screen.getByRole('button', { name: 'Project: Northwind' })).toBeTruthy();
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(fx.started).toEqual([expect.objectContaining({ projectId: 'bp-northwind' })]);
  });

  it('continues a session of the space in this pane, marking the ones that ask you something', () => {
    mount();
    const row = screen.getByRole('button', { name: /Northwind: Max reply check/ });
    expect(row.textContent).toContain('waits for you');
    fireEvent.click(row);
    expect(fx.resumed).toEqual([{ paneId: 'p1', projectId: 'bp-northwind', sessionId: 's-ask' }]);
  });
});
