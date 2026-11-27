// The agent and model a new chat starts with, in every place that starts one: the empty pane's
// launcher, the sidebar's New session and the pane toolbar's "+" (agent-options.ts says what is
// offered). A native select, so it takes the look of the place it sits in and the keyboard of the
// platform; one group per agent.
import { useState } from 'react';

import { useChatModels, useProviders } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { FOCUS } from '@/shared/view/ui';

import { agentGroups, choiceValue, defaultChoice, entryOf, parseChoice, type AgentChoice, type AgentGroup } from './agent-options';

/**
 * The agents on offer and the one chosen: the user's pick while it is still offered, else the default
 * agent with its default model. `choice` is null while no agent with a chat is set up. `models: false`:
 * a place that offers no new session now asks the host for no model list.
 */
export function useAgentChoice(options: { models?: boolean } = {}): { groups: AgentGroup[]; choice: AgentChoice | null; choose: (choice: AgentChoice) => void } {
  const { data: providers } = useProviders();
  const { data: models } = useChatModels({ enabled: options.models ?? true });
  const [picked, setPicked] = useState<AgentChoice | null>(null);
  const groups = agentGroups(providers, models);
  const choice = entryOf(groups, picked) ? picked : defaultChoice(groups, providers);
  return { groups, choice, choose: setPicked };
}

/** What an entry reads as in a list: the agent's note follows the default model's line. */
export function entryText(group: AgentGroup, index: number): string {
  const entry = group.entries[index];
  return index === 0 && group.note ? `${entry.label} (${group.note})` : entry.label;
}

export function AgentPicker({ groups, choice, onChoose, className }: {
  groups: AgentGroup[];
  choice: AgentChoice | null;
  onChoose: (choice: AgentChoice) => void;
  className?: string;
}) {
  if (!choice || groups.length === 0) return null;
  return (
    <select
      aria-label="Agent and model"
      value={choiceValue(choice)}
      title={entryOf(groups, choice)?.description}
      onChange={(event) => { const next = parseChoice(event.target.value); if (next) onChoose(next); }}
      // The launcher's quiet select by default; a place with its own field style passes that instead.
      className={className ?? cn('h-(--size-tab) max-w-64 truncate rounded-(--radius-tab) bg-transparent px-2 text-ui text-muted-foreground hover:bg-muted hover:text-foreground', FOCUS)}
    >
      {groups.map((group) => (
        <optgroup key={group.provider} label={group.label}>
          {group.entries.map((entry, index) => (
            <option key={entry.value} value={entry.value} title={entry.description}>{entryText(group, index)}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
