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
let fallbackOn = false;
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
  fallbackOn = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/providers') return new Response(JSON.stringify({ providers }));
    if (url === '/api/terminal-fallback') return new Response(JSON.stringify({ enabled: fallbackOn }));
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
    expect(onAddPane).toHaveBeenCalledWith('chat', 'codex', 'gpt-6-luna', undefined);
  });

  it('asks for no model list in a toolbar without "+" (a task\'s panel)', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MainContentTabSwitcher groups={[]} paneView="chat" onSetPaneView={() => {}} onClosePane={() => {}} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toContain('/api/providers'));
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).not.toContain('/api/providers/models');
  });

  it('offers an agent without a chat only while the terminal fallback is on, and opens it there', async () => {
    providers = [agent('qwen', 'Qwen Code', { isDefault: true, capabilities: { chat: { supported: false, reason: 'Terminal only.' }, endTurnTool: yes, messaging: yes } })];
    const onAddPane = vi.fn();
    mount(onAddPane);
    fireEvent.click(screen.getByRole('button', { name: 'New pane next to this one' }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toContain('/api/terminal-fallback'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: /Qwen Code/ })).toBeNull();
    cleanup();

    fallbackOn = true;
    mount(onAddPane);
    fireEvent.click(screen.getByRole('button', { name: 'New pane next to this one' }));
    const item = await within(screen.getByRole('menu')).findByRole('menuitem', { name: 'New Qwen Code session (terminal fallback)' });
    fireEvent.click(item);
    expect(onAddPane).toHaveBeenCalledWith('chat', 'qwen', undefined, true);
  });
});

describe('the pane toolbar\'s ··· menu', () => {
  it('holds the session\'s terminal fallback when it is given, and nothing otherwise', () => {
    const run = vi.fn();
    mount(() => {});
    expect(screen.queryByRole('button', { name: 'More session actions' })).toBeNull();
    cleanup();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MainContentTabSwitcher paneView="chat" onSetPaneView={() => {}} fallback={{ label: 'Open in terminal (fallback)', run }} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in terminal (fallback)' }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('has no Terminal tab: the session\'s one view is the chat', () => {
    mount(() => {});
    expect(screen.queryByRole('radio', { name: 'Terminal' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Chat' })).toBeTruthy();
  });
});
