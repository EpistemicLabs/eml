// The home's agents as the host lists them (GET /api/agents): id, display
// name, the brain's id and the spaces each works in. Settings › Agents and
// Settings › Brain read it when they open.
import { useEffect, useState } from 'react';

export type AgentInfo = {
  id: string;
  name: string;
  brainId: string;
  /** It runs in a runtime of its own, not the cockpit's default. */
  runtime: boolean;
  spaces: Array<{ id: string; name: string }>;
};

export type AgentsInfo = {
  /** The home's human: the handle every write carries. */
  handle: string | null;
  agents: AgentInfo[];
};

export function useAgents(): { agents: AgentInfo[]; handle: string | null; loaded: boolean; failed: boolean } {
  const [info, setInfo] = useState<AgentsInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/agents')
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return (await res.json()) as AgentsInfo;
      })
      .then(
        (value) => { if (!cancelled) setInfo(value); },
        () => { if (!cancelled) setFailed(true); },
      );
    return () => { cancelled = true; };
  }, []);

  return { agents: info?.agents ?? [], handle: info?.handle ?? null, loaded: info !== null, failed };
}

/** An agent's display name by id, null while the list is not there or the id is unknown. */
export function agentName(agents: AgentInfo[], id: string | null): string | null {
  if (!id) return null;
  return agents.find((a) => a.id === id)?.name ?? null;
}
