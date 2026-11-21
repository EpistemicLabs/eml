// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSpaces } from '@/stores/useSpaceStore';
import PluginsTab from './PluginsTab';

// Settings › Plugins: the plugins per space, a plugin's own page, and adding a
// custom MCP server whose secret values go into a sign-in, never the plugin.

const SPACES = [
  { id: 'main-id', name: 'Main', main: true, shared: false, agent: 'juno', agentName: 'Juno' },
  { id: 'other-id', name: 'Other', main: false, shared: false, agent: 'juno', agentName: 'Juno' },
];

const plugin = (over: Record<string, unknown>) => ({
  description: '', tier: 'official', parts: ['pane'], pane: null, channel: null, mcp: null, auth: null, enabled: false, spaces: {}, partsOff: [], ...over,
});

const PLUGINS = [
  plugin({ id: 'note', name: 'Note', pane: 'note', enabled: true, spaces: { 'main-id': null } }),
  plugin({ id: 'gmail', name: 'Gmail', parts: ['channel'], channel: 'gmail', auth: { kind: 'google-oauth', scopes: [] } }),
];

type Call = { url: string; method: string; body: unknown };
let calls: Call[];

beforeEach(async () => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const body = url.startsWith('/api/spaces') ? { spaces: SPACES }
      : url === '/api/plugins/connections' && method === 'GET' ? { connections: [{ id: 'work', plugin: 'gmail', label: 'Work mailbox', secrets: ['address'] }] }
      : url === '/api/plugins/connections' ? { connection: { id: 'lookup-1', plugin: 'lookup', label: 'Settings', secrets: ['API_KEY'] } }
      : url.startsWith('/api/plugins/custom') ? { plugin: {} }
      : url.startsWith('/api/plugins') ? { plugins: PLUGINS }
      : {};
    return new Response(JSON.stringify(body), { status: url.startsWith('/api/plugins/custom') && method === 'POST' ? 201 : 200 });
  }));
  await loadSpaces();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderTab = () => render(<QueryClientProvider client={new QueryClient()}><PluginsTab /></QueryClientProvider>);

describe('Settings › Plugins', () => {
  it('lists each plugin with its tier and parts, and opens its page with sign-ins and spaces', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Gmail/ }));
    expect(await screen.findByText('Sign-ins')).toBeTruthy();
    expect(screen.getByText('Work mailbox')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Gmail in Other' }).getAttribute('aria-checked')).toBe('false');
  });

  it('switches a plugin in one space from the table', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('radio', { name: 'Spaces' }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Note in Other' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ id: 'note', space: 'other-id', enabled: true }));
  });

  it('adds a custom MCP server: the secret as a reference in the plugin, its value only in a sign-in', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('radio', { name: 'Add plugin' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Pipedrive'), { target: { value: 'Lookup' } });
    fireEvent.change(screen.getByPlaceholderText('npx'), { target: { value: 'lookup-mcp' } });
    fireEvent.click(screen.getByRole('button', { name: /Add a value/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'API_KEY' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'placeholder-value' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Other/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add plugin' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const custom = calls.find((c) => c.url === '/api/plugins/custom');
    expect(custom?.body).toEqual({ id: 'lookup', name: 'Lookup', parts: { mcp: { transport: 'stdio', command: 'lookup-mcp', args: [], env: { API_KEY: { secret: 'API_KEY' } } } } });
    expect(JSON.stringify(custom?.body)).not.toContain('placeholder-value');
    expect(calls.find((c) => c.url === '/api/plugins/connections' && c.method === 'POST')?.body).toEqual({ plugin: 'lookup', label: 'Settings', values: { API_KEY: 'placeholder-value' } });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ id: 'lookup', space: 'other-id', enabled: true, connection: 'lookup-1' });
  });
});
