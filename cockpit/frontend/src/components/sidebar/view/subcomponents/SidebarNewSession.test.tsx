// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fx = vi.hoisted(() => ({ opened: [] as Array<[string | null, Record<string, unknown>]>, started: [] as unknown[] }));

vi.mock('@/stores/usePaneStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useActiveSpaceId: () => null,
  openSessionInSpace: (key: string | null, target: Record<string, unknown>) => { fx.opened.push([key, target]); return 'pane'; },
}));
vi.mock('@/stores/useSpaceStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSpaces: () => [{ id: 'main', name: 'Main', main: true }],
}));

import { peekChatStart } from '@/components/chat/chat-start';

import { SidebarNewSession } from './SidebarNewSession';

const yes = { supported: true };
const agent = (id: string, label: string, over: object = {}) => ({
  id, label, version: '1.0.0', problem: null, signedIn: true, isDefault: false,
  capabilities: { chat: yes, endTurnTool: yes, messaging: yes }, ...over,
});

beforeEach(() => {
  fx.opened = []; fx.started = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/providers') return new Response(JSON.stringify({ providers: [agent('claude', 'Claude Code'), agent('codex', 'Codex', { isDefault: true })] }));
    if (url === '/api/providers/models') return new Response(JSON.stringify({ providers: [{ id: 'claude', models: [{ id: 'opus', label: 'Opus 5.5', description: '', resolved: null }] }] }));
    if (url === '/api/projects') return new Response(JSON.stringify({ projects: [{ projectId: 'bp-cs', displayName: 'CS Dashboard Tools', fullPath: '/w/cs' }] }));
    if (url === '/api/sessions/start') { fx.started.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ id: 'host-1', runtime: 'sdk' })); }
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SidebarNewSession onError={() => {}} /></QueryClientProvider>);

async function openPanel(): Promise<HTMLSelectElement> {
  mount();
  fireEvent.click(screen.getByRole('button', { name: /New session/ }));
  await screen.findByRole('option', { name: 'CS Dashboard Tools' });
  return await screen.findByRole('combobox', { name: 'Agent and model' }) as HTMLSelectElement;
}

describe('the sidebar\'s New session', () => {
  it('opens a new chat of the default agent, with the model picked', async () => {
    const picker = await openPanel();
    expect(picker.selectedOptions[0].textContent).toBe('Codex · default model');
    fireEvent.change(picker, { target: { value: (within(picker).getByRole('option', { name: 'Claude Code · Opus 5.5' }) as HTMLOptionElement).value } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(fx.opened).toEqual([[null, expect.objectContaining({ surface: 'session', projectId: 'bp-cs', provider: 'claude' })]]);
    expect(peekChatStart(fx.opened[0][1].sessionId as string)).toEqual({ provider: 'claude', prompt: null, model: 'opus' });
  });

  it('starts one with a prompt on the host, with the agent and model picked', async () => {
    await openPanel();
    fireEvent.change(screen.getByRole('textbox', { name: 'What should it do?' }), { target: { value: 'Tidy the imports' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(fx.started).toEqual([{ projectId: 'bp-cs', prompt: 'Tidy the imports', provider: 'codex', model: null }]));
  });
});
