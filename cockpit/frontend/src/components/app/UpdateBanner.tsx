// Update banner (v0.14 Cluster 0, decision app-update-flow): the outcome of
// the last brain-schema update, from the host (GET /api/update-status).
// Success is green and can be dismissed. Failure is red and stays until the
// brain has caught up: it is the only place that says why the brain is
// offline. Later the same strip announces "update available".
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, FolderSearch, X, XCircle } from 'lucide-react';

type MigrationReport = {
  brainId: string;
  brainName: string;
  from: number;
  to: number;
  outcome: 'migrated' | 'brain_missing' | 'backup_failed' | 'preflight_failed' | 'restored' | 'restore_failed';
  error?: string;
  backupPath?: string;
  codeVersion?: string;
  at: string;
  reportPath: string;
};

type UpdateStatus = {
  report: MigrationReport | null;
  acknowledged: boolean;
  resolved: boolean;
};

const POLL_MS = 60_000;

// What the failure means for the brain, per outcome.
const FAILURE_STATE: Record<Exclude<MigrationReport['outcome'], 'migrated'>, string> = {
  preflight_failed: 'was not changed',
  backup_failed: 'was not changed (no backup could be taken)',
  restored: 'was restored from the backup',
  brain_missing: 'has no data file on disk',
  restore_failed: 'could NOT be restored automatically — restore it from the backup below',
};

export default function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/update-status');
      if (res.ok) setStatus((await res.json()) as UpdateStatus);
    } catch { /* host unreachable: keep the last state */ }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    window.addEventListener('focus', load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [load]);

  const report = status?.report;
  if (!status || !report || status.acknowledged) return null;
  // A failure that has since been fixed (a later start migrated the brain) is
  // superseded by that start's own report; nothing to show for it here.
  if (report.outcome !== 'migrated' && status.resolved) return null;

  const ok = report.outcome === 'migrated';
  const failureState = report.outcome === 'migrated' ? '' : FAILURE_STATE[report.outcome];
  const version = report.codeVersion && report.codeVersion !== '0.0.0' ? ` to ${report.codeVersion}` : '';

  const dismiss = async () => {
    const res = await fetch('/api/update-status/ack', { method: 'POST' });
    if (res.ok) setStatus({ ...status, acknowledged: true });
  };
  const revealBackup = () => void fetch('/api/update-status/reveal-backup', { method: 'POST' });

  return (
    <div
      role={ok ? 'status' : 'alert'}
      className={`flex-shrink-0 border-b px-3 py-2 text-[13px] ${
        ok
          ? 'border-success/30 bg-success/10 text-success'
          : 'border-destructive/40 bg-destructive/10 text-destructive'
      }`}
    >
      <div className="flex items-start gap-2.5">
        {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {ok
              ? `Updated${version} — brain “${report.brainName}” migrated v${report.from} → v${report.to}.`
              : `Brain update failed — “${report.brainName}” is still on v${report.from} and ${failureState}. The brain is offline until the update succeeds.`}
          </div>
          {!ok && report.error && <div className="mt-0.5 break-words font-mono text-xs opacity-90">Reason: {report.error}</div>}
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs opacity-90">
            <button type="button" className="inline-flex items-center gap-1 hover:underline" onClick={() => setOpen((v) => !v)}>
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {open ? 'Hide report' : 'Show report'}
            </button>
            {report.backupPath && (
              <button type="button" className="inline-flex items-center gap-1 hover:underline" onClick={revealBackup}>
                <FolderSearch className="h-3 w-3" /> Reveal backup
              </button>
            )}
          </div>
          {open && (
            <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-background/70 p-2 font-mono text-[11px] text-foreground">
              {JSON.stringify(report, null, 2)}
            </pre>
          )}
        </div>
        {ok && (
          <button type="button" aria-label="Dismiss" className="rounded p-0.5 hover:bg-foreground/10" onClick={() => void dismiss()}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
