// What the agent picker offers for a new chat: every agent the host reports that is set up and whose
// sessions run in the chat (capabilities.chat), each with its default model and the models it lists
// (GET /api/providers/models). No agent is named here: one the host starts reporting shows up as it is.
import type { ModelOption } from '@/components/chat/chat-state';
import type { AgentProviderInfo } from '@/lib/providers';

/** A new chat's agent and model; model null: the agent's default. */
export interface AgentChoice {
  provider: string;
  model: string | null;
}

export interface AgentEntry {
  /** The option's value (choiceValue). */
  value: string;
  choice: AgentChoice;
  /** "Claude Code · Opus", "Codex · default model". */
  label: string;
  /** The model's own name; null for the default model. */
  modelLabel: string | null;
  description: string;
}

export interface AgentGroup {
  provider: string;
  label: string;
  /** Why a chat of it may not start yet (shown next to it); null when it is ready. */
  note: string | null;
  entries: AgentEntry[];
}

/** One string per choice, for a <select>. */
export function choiceValue(choice: AgentChoice): string {
  return JSON.stringify([choice.provider, choice.model]);
}

/** The choice a value stands for; null for one that is none. */
export function parseChoice(value: string): AgentChoice | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || (parsed[1] !== null && typeof parsed[1] !== 'string')) return null;
    return { provider: parsed[0], model: parsed[1] };
  } catch {
    return null;
  }
}

/**
 * The picker's groups, in the host's order. An agent that is set up but not signed in stays in the list
 * with a note: the host's answer is about the cockpit's own sign-in, and a space with its own agent
 * signs in per folder, so it may well start; if not, its chat says how to sign in.
 */
export function agentGroups(providers: AgentProviderInfo[] | undefined, models: Array<{ id: string; models: ModelOption[] }> | undefined): AgentGroup[] {
  return (providers ?? [])
    .filter((provider) => provider.version !== null && provider.capabilities?.chat.supported === true)
    .map((provider) => {
      const listed = models?.find((entry) => entry.id === provider.id)?.models ?? [];
      const entry = (model: ModelOption | null): AgentEntry => {
        const choice = { provider: provider.id, model: model?.id ?? null };
        return {
          value: choiceValue(choice), choice,
          label: `${provider.label} · ${model ? model.label : 'default model'}`,
          modelLabel: model?.label ?? null,
          description: model?.description ?? `What ${provider.label} starts with unless you pick a model`,
        };
      };
      return {
        provider: provider.id,
        label: provider.label,
        note: provider.problem ? 'not ready' : provider.signedIn ? null : 'not signed in',
        // A model listed twice (an alias beside its id) is offered once.
        entries: [entry(null), ...listed.filter((model, i) => listed.findIndex((other) => other.id === model.id) === i).map(entry)],
      };
    });
}

/** What the picker starts on: the default agent (Settings › Models) with its default model, else the first offered. */
export function defaultChoice(groups: AgentGroup[], providers: AgentProviderInfo[] | undefined): AgentChoice | null {
  const preferred = providers?.find((provider) => provider.isDefault)?.id;
  const group = groups.find((one) => one.provider === preferred) ?? groups[0];
  return group ? group.entries[0].choice : null;
}

/** The entry for a choice, if the groups still offer it. */
export function entryOf(groups: AgentGroup[], choice: AgentChoice | null): AgentEntry | null {
  if (!choice) return null;
  const value = choiceValue(choice);
  for (const group of groups) for (const entry of group.entries) if (entry.value === value) return entry;
  return null;
}
