// A space's brain as the host describes it (GET /api/brain-info): file, id,
// schema, and who is in it. Settings › Spaces and Data each read it
// when they open: the active space's, or in Brain the one picked there.
import { useEffect, useState } from 'react';

import { SPACE_HEADER } from '@/lib/space-header';

export type BrainInfo = {
  source: 'local';
  home: string;
  brainId: string | null;
  /** The brain's control-plane name — the agent id it was set up with. */
  brainName: string | null;
  brainFile: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  schemaVersion: number | null;
  createdAt: string | null;
  /** The handle stamped on every engram this cockpit's sessions write. */
  author: string | null;
  agents: Array<{ id: string; name: string }>;
  users: Array<{ id: string; name: string }>;
};

export function useBrainInfo(spaceId?: string): { info: BrainInfo | null; failed: boolean } {
  const [info, setInfo] = useState<BrainInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setFailed(false);
    fetch('/api/brain-info', spaceId ? { headers: { [SPACE_HEADER]: spaceId } } : undefined)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return (await res.json()) as BrainInfo;
      })
      .then(
        (value) => { if (!cancelled) setInfo(value); },
        () => { if (!cancelled) setFailed(true); },
      );
    return () => { cancelled = true; };
  }, [spaceId]);

  return { info, failed };
}

/** The agent this brain was set up with (its id is the brain's name), else the first one. */
export function mainAgent(info: BrainInfo | null): { id: string; name: string } | null {
  if (!info) return null;
  return info.agents.find((agent) => agent.id === info.brainName) ?? info.agents[0] ?? null;
}
