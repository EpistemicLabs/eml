// The outcome of an in-app update, shown by the update banner in place of its
// success strip until the update is dismissed: "Updated to vX", the brain's
// migration if it had one, and the "What's new" bullets of every release the
// update went through, newest first, read from GitHub when it opens. Closing it
// is the banner's dismiss — the update is seen; nothing else is stored.
import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button, Dialog, DialogContent, DialogTitle, FOCUS, LABEL } from '@/shared/view/ui';

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
      <DialogContent className="max-h-(--size-dialog-tall) max-w-measure overflow-y-auto p-6">
        <DialogTitle>Updated to v{to}</DialogTitle>
        <h2 className="flex items-center gap-2 text-title font-semibold text-foreground">
          <CheckCircle2 aria-hidden className="size-5 text-foreground" /> Updated to v{to}
        </h2>
        {brainLine && <p className="mt-1 text-body text-muted-foreground">{brainLine}</p>}
        <h3 className={cn('mt-5', LABEL)}>What’s new since v{from}</h3>
        {error ? (
          <p className="mt-4 text-body text-muted-foreground">
            The release notes could not be loaded ({error}).{' '}
            <a className={cn('text-foreground underline underline-offset-2 hover:no-underline', FOCUS)} href={RELEASES_URL} target="_blank" rel="noreferrer">Read them on GitHub</a>.
          </p>
        ) : !notes ? (
          <Loader2 className="mt-4 size-4 animate-spin text-muted-foreground" />
        ) : (
          notes.map((release) => (
            <section key={release.version} className="mt-4">
              <h3 className="flex items-center gap-2 text-body font-semibold text-foreground">
                v{release.version}
                {release.url && (
                  <a className={cn('inline-flex min-h-(--target-min) items-center gap-1 text-ui font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground', FOCUS)} href={release.url} target="_blank" rel="noreferrer">
                    Full notes <ExternalLink aria-hidden className="size-3" />
                  </a>
                )}
              </h3>
              {release.highlights.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1.5 pl-5 text-body text-foreground">
                  {release.highlights.map((highlight, i) => <li key={i}>{highlight}</li>)}
                </ul>
              ) : (
                <p className="mt-2 text-body text-muted-foreground">No summary for this release — see the full notes.</p>
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
