import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/view/ui';

type ReleaseItem = { version: string; url: string; highlights: string[] };
type Preview = { from: string; to: string; releases: ReleaseItem[]; fallback: boolean };

export default function ReleasePreviewDialog() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [index, setIndex] = useState(0);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/release-preview', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load release notes (HTTP ${res.status})`);
        return res.json() as Promise<Preview | null>;
      })
      .then((result) => { if (!cancelled) { setPreview(result); setIndex(0); } })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load release notes'); });
    return () => { cancelled = true; };
  }, []);

  const dismiss = useCallback(async () => {
    if (closing || !preview) return;
    setClosing(true);
    setError(null);
    try {
      const res = await fetch('/api/release-preview/ack', { method: 'POST' });
      if (!res.ok) throw new Error(`Could not save that you have read these notes (HTTP ${res.status})`);
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the release preview');
    } finally {
      setClosing(false);
    }
  }, [closing, preview]);

  const release = preview?.releases[index];
  const hasNotes = !!release?.highlights.length;

  return (
    <Dialog open={!!preview} onOpenChange={(open) => { if (!open) void dismiss(); }}>
      {preview && release && (
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden border border-border bg-card p-0 shadow-xl">
          <DialogTitle>What’s new in EML v{release.version}</DialogTitle>
          <div className="flex max-h-[85vh] flex-col">
            <header className="border-b border-border px-6 py-5">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">EML Cockpit · What’s new</div>
              <h2 className="mt-1 text-xl font-semibold text-foreground">Version {release.version}</h2>
              {preview.releases.length > 1 && (
                <div className="mt-1 text-sm text-muted-foreground">{index + 1} of {preview.releases.length} releases</div>
              )}
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {hasNotes ? (
                <ul className="list-disc space-y-3 pl-5 text-sm leading-6 text-foreground">
                  {release.highlights.map((highlight, i) => <li key={`${release.version}-${i}`}>{highlight}</li>)}
                </ul>
              ) : (
                <p className="text-sm leading-6 text-muted-foreground">
                  The highlights for this release are not available in the preview. You can read the release notes on GitHub.
                </p>
              )}
              {release.url && (
                <a className="mt-5 inline-flex items-center gap-1.5 text-sm text-primary hover:underline" href={release.url} target="_blank" rel="noreferrer">
                  Full release notes <ExternalLink aria-hidden className="size-3.5" />
                </a>
              )}
              {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
            </div>

            <footer className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
              <Button variant="outline" size="sm" disabled={closing || index >= preview.releases.length - 1} onClick={() => setIndex((i) => Math.min(i + 1, preview.releases.length - 1))}>
                <ArrowLeft aria-hidden /> Older
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" disabled={closing || index === 0} onClick={() => setIndex((i) => Math.max(i - 1, 0))}>
                  Newer <ArrowRight aria-hidden />
                </Button>
                <Button size="sm" disabled={closing} loading={closing} onClick={() => void dismiss()}>
                  Got it
                </Button>
              </div>
            </footer>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
