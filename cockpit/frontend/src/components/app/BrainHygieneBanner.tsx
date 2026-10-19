// "Brain hygiene" strip under the header (spec note brain-hygiene-spec): the
// host offers a session for the open space when a schema migration left
// entries to rewrite or reviews are due (GET /api/brain-hygiene). Start opens
// the session in the space's "Brain hygiene" folder; Not now counts as
// offered too. Both are recorded by the host, so the strip stays away until
// the next schema or the next week.
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

import { SPACE_CHANGED_EVENT } from '@/stores/useSpaceStore';

type HygieneOffer = { space: string; reasons: string[]; findings: number };

const POLL_MS = 10 * 60_000;

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export default function BrainHygieneBanner() {
  const [offer, setOffer] = useState<HygieneOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/brain-hygiene', { cache: 'no-store' });
      if (res.ok) setOffer(((await res.json()) as { offer: HygieneOffer | null }).offer);
    } catch { /* host unreachable: keep the last state */ }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const onSpace = () => { setOffer(null); setError(null); void load(); };
    window.addEventListener(SPACE_CHANGED_EVENT, onSpace);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(SPACE_CHANGED_EVENT, onSpace);
    };
  }, [load]);

  const act = async (action: 'start' | 'dismiss') => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/brain-hygiene/${action}`, { method: 'POST' });
      if (!res.ok) setError(await errorMessage(res));
      else await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!offer) return null;

  return (
    <div role="status" className="flex-shrink-0 border-b border-info/30 bg-info/10 px-3 py-2 text-[13px] text-info">
      <div className="flex items-center gap-2.5">
        {busy ? <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" /> : <Sparkles className="h-4 w-4 flex-shrink-0" />}
        <div className="min-w-0 flex-1">
          <span className="font-medium">Brain hygiene for {offer.space}: {offer.reasons.join('; ')}.</span>
          {error && <div className="mt-0.5 break-words text-xs text-destructive">{error}</div>}
        </div>
        <button
          type="button"
          disabled={busy}
          className="rounded-md bg-info px-2.5 py-1 text-xs font-medium text-background hover:bg-info/90 disabled:opacity-60"
          onClick={() => void act('start')}
        >
          Start
        </button>
        <button
          type="button"
          disabled={busy}
          className="rounded-md px-2 py-1 text-xs hover:bg-foreground/10 disabled:opacity-60"
          onClick={() => void act('dismiss')}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
