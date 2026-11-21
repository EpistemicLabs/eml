// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSpaces } from '@/stores/useSpaceStore';
import { SETTINGS_MAIN_TABS } from '../../constants/constants';
import PluginsTab from './PluginsTab';
import { splitCommand } from './AddCustomMcp';

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
  plugin({ id: 'stripe', name: 'stripe', tier: 'custom', parts: ['mcp'], mcp: { transport: 'stdio', target: 'npx', settings: [] }, imported: true }),
  plugin({ id: 'gmail', name: 'Gmail', parts: ['mcp', 'channel'], channel: 'gmail', mcp: { transport: 'stdio', target: 'node', settings: [{ name: 'GMAIL_ADDRESS', secret: true }] }, auth: { kind: 'google-oauth', scopes: [] }, spaces: { 'main-id': ['work'] } }),
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
      : url === '/api/plugins/connections' && method === 'GET' ? { connections: [{ id: 'work', plugin: 'gmail', label: 'Work mailbox', secrets: ['address'], slug: null, address: 'me@work.example' }, { id: 'invoice', plugin: 'gmail', label: 'Invoices', secrets: ['address'], slug: 'invoice', address: 'invoice@work.example' }] }
      : url === '/api/plugins/google/client' ? { configured: method === 'PUT', fromSignIns: [{ id: 'work', label: 'Work mailbox' }] }
      : url === '/api/plugins/connections' ? { connection: { id: 'lookup-1', plugin: 'lookup', label: 'Settings', secrets: ['API_KEY'] } }
      : url.startsWith('/api/plugins/custom') ? { plugin: {} }
      : url.startsWith('/api/plugins/outside') ? { servers: [{ name: 'claude.ai Slack', kind: 'connector', off: ['other-id'] }] }
      : url.startsWith('/api/plugins') ? { plugins: PLUGINS, importNotice: { count: 1 } }
      : {};
    return new Response(JSON.stringify(body), { status: url.startsWith('/api/plugins/custom') && method === 'POST' ? 201 : 200 });
  }));
  await loadSpaces();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TAB = SETTINGS_MAIN_TABS.find((t) => t.id === 'plugins')!;
const renderTab = () => render(<QueryClientProvider client={new QueryClient()}><PluginsTab tab={TAB} /></QueryClientProvider>);

describe('Settings › Plugins', () => {
  it('lists each plugin with its tier and parts, and opens its page with sign-ins and spaces', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Gmail/ }));
    expect(await screen.findByText('Sign-ins')).toBeTruthy();
    expect(screen.getAllByText('Work mailbox').length).toBeGreaterThan(0);
    expect(screen.getByText(/its tools: gmail-invoice/)).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Gmail in Other' }).getAttribute('aria-checked')).toBe('false');
  });

  it('switches a plugin in one space from the table', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: 'Spaces' }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Note in Other' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ id: 'note', space: 'other-id', enabled: true }));
  });

  it('shows the connectors as rows of the spaces table, each switch per space', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: 'Spaces' }));
    expect((await screen.findByRole('switch', { name: 'claude.ai Slack in Main' })).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'claude.ai Slack in Other' }).getAttribute('aria-checked')).toBe('false');
  });

  it('tells of the imported servers until done, and filters the list to them', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Review imported' }));
    expect(await screen.findByText(/Showing the imported custom MCP plugins \(1\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Gmail/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/plugins/import-notice' && c.method === 'DELETE')).toBe(true));
  });

  it('adds a custom MCP server: the secret as a reference in the plugin, its value only in a sign-in', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: 'Add plugin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add custom MCP…' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Pipedrive'), { target: { value: 'Lookup' } });
    fireEvent.change(screen.getByPlaceholderText('npx -y @vendor/mcp-server'), { target: { value: 'lookup-mcp --region eu' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Variable name' }), { target: { value: 'API_KEY' } });
    fireEvent.change(screen.getByLabelText('Secret value'), { target: { value: 'placeholder-value' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Other/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add plugin' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const custom = calls.find((c) => c.url === '/api/plugins/custom');
    expect(custom?.body).toEqual({ id: 'lookup', name: 'Lookup', parts: { mcp: { transport: 'stdio', command: 'lookup-mcp', args: ['--region', 'eu'], env: { API_KEY: { secret: 'API_KEY' } } } } });
    expect(JSON.stringify(custom?.body)).not.toContain('placeholder-value');
    expect(calls.find((c) => c.url === '/api/plugins/connections' && c.method === 'POST')?.body).toEqual({ plugin: 'lookup', label: 'Settings', values: { API_KEY: 'placeholder-value' } });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ id: 'lookup', space: 'other-id', enabled: true, connections: ['lookup-1'] });
  });

  it('lets a space use several Google accounts at once, each toggled on its own', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: 'Spaces' }));
    const invoice = await screen.findByRole('button', { name: 'Gmail Invoices in Main' });
    expect(invoice.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(invoice);
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ id: 'gmail', space: 'main-id', enabled: true, connections: ['work', 'invoice'] }));
  });

  it('asks for the own Google OAuth client before the first Google sign-in', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Gmail/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add another Google account' }));
    expect(await screen.findByRole('textbox', { name: 'OAuth client JSON' })).toBeTruthy();
  });

  it('offers the OAuth client of an earlier sign-in instead of asking for the JSON', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Gmail/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add another Google account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Work mailbox' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/plugins/google/client' && c.method === 'PUT')?.body).toEqual({ fromConnection: 'work' }));
  });

  it('splits a command line at spaces outside quotes', () => {
    expect(splitCommand('npx -y "@vendor/mcp server" --flag')).toEqual(['npx', '-y', '@vendor/mcp server', '--flag']);
  });
});
