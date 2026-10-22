// "Brain hygiene" strip under the header (spec note brain-hygiene-spec): the
// host offers a session for the open space when a schema migration left
// entries to rewrite or reviews are due (GET /api/brain-hygiene). Start opens
// the session in the space's "Brain hygiene" folder. The strip stays until
// started; the host records the start, so it stays away until the next schema
// or the next week.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';

import { SPACE_CHANGED_EVENT } from '@/stores/useSpaceStore';
import { Banner, BannerButton } from './Banner';

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
  // Only the latest request may set the offer: after a space switch, an answer
  // for the previous space arrives late and is dropped.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const res = await fetch('/api/brain-hygiene', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { offer: HygieneOffer | null };
      if (request === latest.current) setOffer(body.offer);
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

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/brain-hygiene/start', { method: 'POST' });
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
    <Banner
      tone="info"
      icon={Sparkles}
      busy={busy}
      detail={error}
      actions={<BannerButton disabled={busy} onClick={() => void start()}>Start</BannerButton>}
    >
      Brain hygiene for “{offer.space}”: {offer.reasons.join('; ')}.
    </Banner>
  );
}
