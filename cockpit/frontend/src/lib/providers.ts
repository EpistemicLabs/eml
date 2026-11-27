// The agent CLIs a session can run with (host: /api/providers). One query for
// every place that needs them — the "+" menu, Settings › Models.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ModelOption } from '@/components/chat/chat-state';
import type { LLMProvider } from '@/types/app';

export interface RuntimeResult {
  at: string;
  outcome: 'installed' | 'updated' | 'up_to_date' | 'rolled_back' | 'failed';
  from?: string | null;
  to?: string | null;
  error?: string;
}

/** The cockpit's own copy of a CLI: which version runs, what the last check did. */
export interface RuntimeState {
  channel: string;
  autoUpdate: boolean;
  current: string | null;
  previous: string | null;
  lastCheckAt: string | null;
  lastResult: RuntimeResult | null;
}

/** Whether a provider can do something; when not, why (the host's wording). */
export type Capability = { supported: true } | { supported: false; reason: string };

export interface ProviderCapabilities {
  /** Sessions can run in the chat view. */
  chat: Capability;
  endTurnTool: Capability;
  messaging: Capability;
  /** Terminal sessions get the cockpit's tools from the host. Missing from a host older than this frontend. */
  terminalTools?: Capability;
}

export interface AgentProviderInfo {
  id: LLMProvider;
  /** Product name, e.g. "Claude Code". */
  label: string;
  /** The usable version; null when sessions of this provider cannot start. */
  version: string | null;
  /** Why sessions can't start, and what to do about it. */
  problem: string | null;
  problemHint: string;
  runtime: RuntimeState;
  signedIn: boolean;
  /** New sessions start with this one unless they name another. */
  isDefault: boolean;
  /** The provider's own switches; null when it has none here. */
  settings: Record<string, boolean | string> | null;
  /** What sessions of this provider can do. Missing from a host older than this frontend. */
  capabilities?: ProviderCapabilities;
}

const providersKey = ['agent-providers'] as const;

async function request(path = '', init?: RequestInit): Promise<AgentProviderInfo[]> {
  const res = await fetch(`/api/providers${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  return (body?.providers ?? []) as AgentProviderInfo[];
}

const send = (method: 'PATCH' | 'POST', body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/**
 * The providers. `refresh` (Settings › Models) makes the host look at the
 * sign-ins afresh; the menus take the host's cached answer — a sign-in check
 * is a process per provider.
 */
export function useProviders(options: { refresh?: boolean } = {}) {
  return useQuery({ queryKey: providersKey, queryFn: () => request(options.refresh ? '?refresh=1' : ''), staleTime: 15_000 });
}

/** The models one agent offers a new chat (host: application/chat-models.ts). */
export interface ProviderModels {
  id: string;
  models: ModelOption[];
}

/**
 * The models each chat-capable agent offers a new chat (GET /api/providers/models), for the agent
 * picker. Kept a few minutes: the host keeps them longer, and a model list rarely changes. A host
 * that cannot say answers no models, and the picker offers each agent's default model alone.
 */
export function useChatModels() {
  return useQuery({
    queryKey: [...providersKey, 'models'],
    queryFn: async (): Promise<ProviderModels[]> => {
      const res = await fetch('/api/providers/models');
      const body = await res.json().catch(() => null);
      return res.ok && Array.isArray(body?.providers) ? body.providers as ProviderModels[] : [];
    },
    staleTime: 5 * 60_000,
  });
}

/**
 * Whether sessions of this provider can run in the chat view. Without the
 * host's answer (list not loaded, a host that does not send capabilities yet)
 * only Claude has a chat.
 */
export function providerCanChat(providers: AgentProviderInfo[] | undefined, id: string | null | undefined): boolean {
  const capabilities = providers?.find((provider) => provider.id === id)?.capabilities;
  return capabilities ? capabilities.chat.supported : id === 'claude';
}

/**
 * The provider a new chat names to the host: the one its pane was opened for, else the cockpit's
 * default. Only one that can run in the chat is named; without one the host starts its own
 * default for a chat, as it always did.
 */
export function chatProvider(providers: AgentProviderInfo[] | undefined, paneProvider: string | null | undefined, defaultProvider: string | null): string | null {
  const named = paneProvider ?? defaultProvider;
  return named && providerCanChat(providers, named) ? named : null;
}

/**
 * The "+" menus' wording for a new agent session: "New Claude Code session".
 * Without a provider (list not loaded, none set up) it reads "New session".
 */
export function newSessionLabel(provider?: Pick<AgentProviderInfo, 'label'> | null): string {
  return provider ? `New ${provider.label} session` : 'New session';
}

/**
 * The menu entries for new agent sessions: one per ready provider when there
 * are several, otherwise one entry (provider undefined → the cockpit's
 * default) named after that default, the provider it will start.
 */
export function newSessionEntries(
  providers: AgentProviderInfo[],
): Array<{ label: string; provider?: LLMProvider }> {
  const ready = providers.filter((provider) => provider.version !== null);
  if (ready.length > 1) return ready.map((provider) => ({ label: newSessionLabel(provider), provider: provider.id }));
  return [{ label: newSessionLabel(providers.find((provider) => provider.isDefault) ?? ready[0]) }];
}

/** Every change answers with the fresh provider list. */
function useProviderMutation<V>(run: (vars: V) => Promise<AgentProviderInfo[]>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: run, onSuccess: (providers) => qc.setQueryData(providersKey, providers) });
}

export const useSetDefaultProvider = () =>
  useProviderMutation((id: LLMProvider) => request('', send('PATCH', { default: id })));

export type RuntimeAction = { check: true } | { rollback: true } | { autoUpdate: boolean };

/** Check now / set up, go back to the previous version, or switch background updates. */
export const useRuntimeAction = (id: LLMProvider) =>
  useProviderMutation((action: RuntimeAction) =>
    'check' in action
      ? request(`/${id}/runtime/check`, send('POST'))
      : 'rollback' in action
        ? request(`/${id}/runtime/rollback`, send('POST'))
        : request(`/${id}/runtime`, send('PATCH', { autoUpdate: action.autoUpdate })));

export const useSetProviderSettings = (id: LLMProvider) =>
  useProviderMutation((patch: Record<string, boolean | string>) => request(`/${id}/settings`, send('PATCH', patch)));
