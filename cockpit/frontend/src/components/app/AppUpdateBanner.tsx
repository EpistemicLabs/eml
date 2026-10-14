// "Update available" strip under the header (decision app-update-flow): the
// host checks GitHub Releases, the user decides. Update installs the release
// and restarts the cockpit; running sessions resume afterwards. "Later" hides
// the strip for that version (per browser).
import { useState } from 'react';
import { ArrowUpCircle, ExternalLink, Loader2, X } from 'lucide-react';

import { useAppUpdate } from '@/hooks/useAppUpdate';

const DISMISSED_KEY = 'eml.appUpdate.dismissed';

function readDismissed(): string | null {
  try { return window.localStorage.getItem(DISMISSED_KEY); } catch { return null; }
}

export default function AppUpdateBanner() {
  const { status, phase, error, apply } = useAppUpdate();
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);

  const latest = status?.latest;
  const busy = phase === 'installing' || phase === 'restarting';
  if (!status || !latest || !status.available) return null;
  if (!busy && !error && dismissed === latest.version) return null;

  const dismiss = () => {
    try { window.localStorage.setItem(DISMISSED_KEY, latest.version); } catch { /* storage blocked */ }
    setDismissed(latest.version);
  };

  return (
    <div role="status" className="flex-shrink-0 border-b border-info/30 bg-info/10 px-3 py-2 text-[13px] text-info">
      <div className="flex items-center gap-2.5">
        {busy ? <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" /> : <ArrowUpCircle className="h-4 w-4 flex-shrink-0" />}
        <div className="min-w-0 flex-1">
          <span className="font-medium">
            {phase === 'installing'
              ? `Installing EML Cockpit v${latest.version}…`
              : phase === 'restarting'
                ? `Restarting into v${latest.version} — the page reloads when it's back.`
                : phase === 'installed-restart-needed'
                  ? `v${latest.version} is installed — restart the cockpit to use it.`
                  : `EML Cockpit v${latest.version} is available (you have v${status.current}).`}
          </span>
          {phase === 'idle' && (
            <span className="ml-2 opacity-80">Updating restarts the cockpit; running sessions resume afterwards.</span>
          )}
          {error && <div className="mt-0.5 break-words text-xs text-destructive">{error}</div>}
        </div>
        {phase === 'idle' && (
          <>
            {latest.url && (
              <a href={latest.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs hover:underline">
                Release notes <ExternalLink className="h-3 w-3" />
              </a>
            )}
            <button
              type="button"
              className="rounded-md bg-info px-2.5 py-1 text-xs font-medium text-background hover:bg-info/90"
              onClick={() => void apply(latest.version)}
            >
              Update
            </button>
            <button type="button" aria-label="Later" title="Later" className="rounded p-0.5 hover:bg-foreground/10" onClick={dismiss}>
              <X className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
