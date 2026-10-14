// The agent CLIs a session can run with (host: /api/providers). One query for
// every place that needs them — the "+" menu, Settings › Models.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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
