// A space without an agent (the agent upgrade could not bind it, host
// agent-upgrade.ts): its sessions start without a brain, so the strip stays
// until it is bound. What the upgrade waits for comes with the space (GET
// /api/spaces → upgrade): the home's handle, which the strip asks for and
// saves (POST /api/agent-upgrade/handle; the upgrade runs at the next start),
// or something the report explains (Show report opens its folder).
import { useState, type FormEvent } from 'react';
import { Bot, FolderSearch } from 'lucide-react';

import { loadSpaces, useActiveSpace } from '@/stores/useSpaceStore';
import { Banner, BannerButton, BannerLink } from './Banner';

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export default function AgentUpgradeBanner() {
  const space = useActiveSpace();
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!space || space.agent !== null) return null;
  const state = space.upgrade;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !handle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/agent-upgrade/handle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: handle.trim() }),
      });
      if (!res.ok) setError(await errorMessage(res));
      else { setSaved(true); await loadSpaces(); }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reveal = () => { void fetch('/api/agent-upgrade/reveal', { method: 'POST' }); };

  const needsHandle = state?.needs === 'handle';
  const detail = error
    ?? (saved ? 'Saved. The upgrade runs when the cockpit starts next.'
      : needsHandle ? 'Enter your handle to finish the upgrade.'
        : state ? `The upgrade stopped: ${state.reason}` : null);

  return (
    <Banner
      tone="info"
      icon={Bot}
      busy={busy}
      detail={detail}
      actions={state?.report && !needsHandle ? <BannerLink icon={FolderSearch} onClick={reveal}>Show report</BannerLink> : undefined}
      below={needsHandle && !saved ? (
        <form className="mt-2 flex items-center gap-2" onSubmit={(e) => void save(e)}>
          <label className="text-xs" htmlFor="agent-upgrade-handle">Your handle</label>
          <input
            id="agent-upgrade-handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="e.g. alex"
            maxLength={63}
            disabled={busy}
            className="h-7 w-40 rounded-md border border-current/30 bg-background px-2 text-xs text-foreground outline-none"
          />
          <BannerButton disabled={busy || !handle.trim()} onClick={() => undefined}>Save</BannerButton>
        </form>
      ) : undefined}
    >
      “{space.name}” has no agent bound — sessions there start without a brain until the upgrade finishes.
    </Banner>
  );
}
