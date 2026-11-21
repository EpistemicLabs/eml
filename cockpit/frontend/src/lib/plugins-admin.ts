// Settings › Plugins: the plugins, their switches per space, the user's
// connections and the claude.ai connectors (host: plugins-api.ts). The pane
// views read their own, smaller answer (pane-views.ts usePluginStates).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type PluginPart = 'pane' | 'mcp' | 'channel';
export type PluginTier = 'official' | 'custom' | 'community' | 'dev';

export interface PluginView {
  id: string;
  name: string;
  description: string;
  tier: PluginTier;
  parts: PluginPart[];
  pane: string | null;
  channel: string | null;
  mcp: { transport: 'stdio' | 'http' | 'sse'; target: string; settings: Array<{ name: string; secret: boolean }> } | null;
  auth: { kind: 'google-oauth' | 'token'; scopes: string[] } | null;
  /** On in any space. */
  enabled: boolean;
  /** Space id → the sign-ins it uses there, for every space it is on in. */
  spaces: Record<string, string[]>;
  partsOff: PluginPart[];
  /** Made by the one-time import of the servers configured outside the plugins. */
  imported: boolean;
}

export interface ConnectionView {
  id: string;
  plugin: string;
  label: string;
  /** The names of the values it holds; the values never reach the page. */
  secrets: string[];
  /** Names its MCP server next to the plugin's own (gmail-invoice); null: the plugin's name. */
  slug: string | null;
  /** The mailbox a Google sign-in is for. */
  address: string | null;
}

export interface OutsideServerView {
  name: string;
  kind: 'connector' | 'claude-plugin';
  /** The spaces it is switched off in. */
  off: string[];
}

const adminKey = ['plugins-admin'] as const;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init && { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  return body as T;
}

const send = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** The plugins, and the notice about the imported servers until the user has seen it. */
export function usePluginList() {
  return useQuery({
    queryKey: [...adminKey, 'list'],
    queryFn: () => request<{ plugins: PluginView[]; importNotice?: { count: number } | null }>('/api/plugins')
      .then((b) => ({ plugins: b.plugins, importNotice: b.importNotice ?? null })),
  });
}

export function useDismissImportNotice() {
  return useChange(() => request('/api/plugins/import-notice', { method: 'DELETE' }));
}

/** The user's sign-ins: names and labels only, never the values. */
export function useConnections() {
  return useQuery({
    queryKey: [...adminKey, 'connections'],
    queryFn: () => request<{ connections: ConnectionView[] }>('/api/plugins/connections').then((b) => b.connections),
    retry: false,
  });
}

export function useOutsideServers() {
  // `claude mcp list` checks every connector: slow the first time, kept by the host for ten minutes.
  return useQuery({ queryKey: [...adminKey, 'outside'], queryFn: () => request<{ servers: OutsideServerView[] }>('/api/plugins/outside').then((b) => b.servers), staleTime: 5 * 60_000 });
}

/** Every change invalidates the admin lists and the panes' own answer (pane-views.ts). */
function useChange<A>(run: (args: A) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: adminKey });
      void qc.invalidateQueries({ queryKey: ['cockpit-plugins'] });
    },
  });
}

/** On or off in a space; `connections` names the sign-ins it uses there (left out: keep them). */
export function useSetPlugin() {
  return useChange(({ id, space, enabled, connections }: { id: string; space: string; enabled: boolean; connections?: string[] }) =>
    request('/api/plugins', send('PATCH', { id, space, enabled, ...(connections !== undefined ? { connections } : {}) })));
}

// ── A Google sign-in with the user's own OAuth client (host: google-sign-in.ts) ──

/** Whether the user's own Google OAuth client is stored, and the earlier sign-ins whose client could be used. */
export function useGoogleClient() {
  return useQuery({
    queryKey: [...adminKey, 'google-client'],
    queryFn: () => request<{ configured: boolean; fromSignIns?: Array<{ id: string; label: string }> }>('/api/plugins/google/client')
      .then((b) => ({ configured: b.configured, fromSignIns: b.fromSignIns ?? [] })),
    retry: false,
  });
}

/** Stores the client: pasted JSON, or the one an earlier sign-in was made with. */
export function useSaveGoogleClient() {
  return useChange((input: { client: string } | { fromConnection: string }) => request('/api/plugins/google/client', send('PUT', input)));
}

/** Google's consent page for a new sign-in, or to sign an existing one in again. */
export function useStartGoogleSignIn() {
  return useMutation({
    mutationFn: ({ plugin, connection }: { plugin: string; connection?: string }) =>
      request<{ url: string }>('/api/plugins/google/sign-in', send('POST', { plugin, ...(connection ? { connection } : {}) })).then((b) => b.url),
  });
}

/** Ends a sign-in with the address the browser was sent to after Google's consent page. */
export function useFinishGoogleSignIn() {
  return useChange(({ plugin, redirect, slug }: { plugin: string; redirect: string; slug?: string }) =>
    request<{ connection: ConnectionView & { again: boolean } }>('/api/plugins/google/sign-in/finish', send('POST', { plugin, redirect, ...(slug ? { slug } : {}) })).then((b) => b.connection));
}

export function useSetPart() {
  return useChange(({ id, part, enabled }: { id: string; part: PluginPart; enabled: boolean }) =>
    request('/api/plugins/parts', send('PATCH', { id, part, enabled })));
}

export function useSetOutside() {
  return useChange(({ space, server, enabled }: { space: string; server: string; enabled: boolean }) =>
    request('/api/plugins/outside', send('PATCH', { space, server, enabled })));
}

export function useAddConnection() {
  return useChange(({ plugin, label, values, slug }: { plugin: string; label: string; values: Record<string, string>; slug?: string }) =>
    request<{ connection: ConnectionView }>('/api/plugins/connections', send('POST', { plugin, label, values, ...(slug ? { slug } : {}) })).then((b) => b.connection));
}

export function useRemoveConnection() {
  return useChange((id: string) => request(`/api/plugins/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export function useRemoveCustom() {
  return useChange((id: string) => request(`/api/plugins/custom/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export interface CustomMcpInput {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  /** The command (stdio) or the URL (http). */
  target: string;
  args: string[];
  /** Env variables (stdio) or headers (http); a secret one is stored once in a connection. */
  values: Array<{ name: string; value: string; secret: boolean }>;
  spaces: string[];
}

/**
 * Adds a custom MCP server: its manifest with the secret values as references,
 * a connection holding them, and the switch in each chosen space.
 */
export function useAddCustomMcp() {
  return useChange(async (input: CustomMcpInput) => {
    const settings = Object.fromEntries(input.values.map((v) => [v.name, v.secret ? { secret: v.name } : v.value]));
    const mcp = input.transport === 'stdio'
      ? { transport: 'stdio', command: input.target, args: input.args, env: settings }
      : { transport: 'http', url: input.target, headers: settings };
    await request('/api/plugins/custom', send('POST', { id: input.id, name: input.name, parts: { mcp } }));
    const secrets = Object.fromEntries(input.values.filter((v) => v.secret).map((v) => [v.name, v.value]));
    const connection = Object.keys(secrets).length > 0
      ? (await request<{ connection: ConnectionView }>('/api/plugins/connections', send('POST', { plugin: input.id, label: 'Settings', values: secrets }))).connection.id
      : null;
    for (const space of input.spaces) await request('/api/plugins', send('PATCH', { id: input.id, space, enabled: true, connections: connection ? [connection] : [] }));
  });
}

/** A plugin id from a name: lower case, digits and dashes, starting with a letter. */
export function idFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 40);
}
