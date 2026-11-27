// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import MainContentTabSwitcher from './MainContentTabSwitcher';

const yes = { supported: true };
const agent = (id: string, label: string, over: object = {}) => ({
  id, label, version: '1.0.0', problem: null, signedIn: true, isDefault: false,
  capabilities: { chat: yes, endTurnTool: yes, messaging: yes }, ...over,
});

let providers: unknown[] = [];
const models = [
  { id: 'claude', models: [{ id: 'opus', label: 'Opus 5.5', description: '', resolved: null }] },
  { id: 'codex', models: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna', description: '', resolved: null }] },
];

beforeEach(() => {
  providers = [
    agent('claude', 'Claude Code', { isDefault: true }),
    agent('codex', 'Codex', { signedIn: false }),
    agent('qwen', 'Qwen Code', { capabilities: { chat: { supported: false, reason: 'Terminal only.' }, endTurnTool: yes, messaging: yes } }),
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/providers') return new Response(JSON.stringify({ providers }));
    if (url === '/api/providers/models') return new Response(JSON.stringify({ providers: models }));
    return new Response(JSON.stringify({ plugins: [] }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = (onAddPane: (...args: unknown[]) => void) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MainContentTabSwitcher paneView="chat" onSetPaneView={() => {}} onAddPane={onAddPane} />
  </QueryClientProvider>,
);

describe('the pane toolbar\'s "+"', () => {
  it('offers a new chat per agent with a chat and per model it lists, and opens the one picked', async () => {
    const onAddPane = vi.fn();
    mount(onAddPane);
    fireEvent.click(screen.getByRole('button', { name: 'New pane next to this one' }));
    const menu = screen.getByRole('menu');
    // The sessions, then the plugins.
    await waitFor(() => expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent).slice(0, 5)).toEqual([
      'New Claude Code chat', 'Opus 5.5', 'New Codex chat· not signed in', 'GPT-6 Luna', 'New brain view',
    ]));
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'GPT-6 Luna' }));
    expect(onAddPane).toHaveBeenCalledWith('chat', 'codex', 'gpt-6-luna');
  });

  it('without any agent that has a chat, offers a session per ready agent CLI as before', async () => {
    providers = [agent('qwen', 'Qwen Code', { isDefault: true, capabilities: { chat: { supported: false, reason: 'Terminal only.' }, endTurnTool: yes, messaging: yes } })];
    const onAddPane = vi.fn();
    mount(onAddPane);
    fireEvent.click(screen.getByRole('button', { name: 'New pane next to this one' }));
    await waitFor(() => expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'New Qwen Code session' })).toBeTruthy());
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'New Qwen Code session' }));
    expect(onAddPane).toHaveBeenCalledWith('terminal', undefined, undefined);
  });
});
