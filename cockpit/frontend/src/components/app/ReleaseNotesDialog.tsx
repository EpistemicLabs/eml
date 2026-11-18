// The outcome of an in-app update, shown by the update banner in place of its
// success strip until the update is dismissed: "Updated to vX", the brain's
// migration if it had one, and the "What's new" bullets of every release the
// update went through, newest first, read from GitHub when it opens. Closing it
// is the banner's dismiss — the update is seen; nothing else is stored.
import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/view/ui';

type ReleaseNotes = { version: string; url: string; highlights: string[] };

const RELEASES_URL = 'https://github.com/EpistemicLabs/eml/releases';

export default function ReleaseNotesDialog({ from, to, brainLine, onClose }: {
  from: string;
  to: string;
  /** The brain's migration with this update, or ''. */
  brainLine: string;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState<ReleaseNotes[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/app-update/notes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then(async (res) => {
        const body = (await res.json()) as ReleaseNotes[] & { error?: { message?: string } };
        if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setNotes(body);
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [from, to]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto border border-border bg-card p-6 shadow-xl">
        <DialogTitle>Updated to v{to}</DialogTitle>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <CheckCircle2 aria-hidden className="h-5 w-5 text-success" /> Updated to v{to}
        </h2>
        {brainLine && <p className="mt-1 text-sm text-muted-foreground">{brainLine}</p>}
        <h3 className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">What’s new since v{from}</h3>
        {error ? (
          <p className="mt-4 text-sm text-muted-foreground">
            The release notes could not be loaded ({error}).{' '}
            <a className="text-primary hover:underline" href={RELEASES_URL} target="_blank" rel="noreferrer">Read them on GitHub</a>.
          </p>
        ) : !notes ? (
          <Loader2 className="mt-4 h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          notes.map((release) => (
            <section key={release.version} className="mt-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                v{release.version}
                {release.url && (
                  <a className="inline-flex items-center gap-1 text-xs font-normal text-primary hover:underline" href={release.url} target="_blank" rel="noreferrer">
                    Full notes <ExternalLink aria-hidden className="size-3" />
                  </a>
                )}
              </h3>
              {release.highlights.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6 text-foreground">
                  {release.highlights.map((highlight, i) => <li key={i}>{highlight}</li>)}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No summary for this release — see the full notes.</p>
              )}
            </section>
          ))
        )}
        <div className="mt-6 flex justify-end">
          <Button size="sm" onClick={onClose}>Got it</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
