// The update banner (decision app-update-flow): one strip for the whole
// update, from "available" through installing and restarting to its outcome.
// "Available" comes from GET /api/app-update and stays until the update is
// installed; the outcome from GET /api/update-status — the in-app update this
// host runs and the last brain-schema migration. Success is green and can be
// dismissed. A failed migration is red and stays until the brain has caught up:
// it is the only place that says why the brain is offline.
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, FolderSearch, XCircle } from 'lucide-react';

import { useAppUpdate } from '@/hooks/useAppUpdate';
import { Banner, BannerButton, BannerLink } from './Banner';

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
  /** The report's brain by its space's name. */
  brain: string | null;
  acknowledged: boolean;
  resolved: boolean;
  updated: { outcome: 'updated' | 'rolled_back'; from: string; to: string } | null;
};

const POLL_MS = 60_000;

// What the failure means for the brain, per outcome.
const FAILURE_STATE: Record<Exclude<MigrationReport['outcome'], 'migrated'>, string> = {
  preflight_failed: 'was not changed',
  backup_failed: 'was not changed (no backup could be taken)',
  restored: 'was restored from the backup',
  brain_missing: 'has no data file on disk',
  restore_failed: 'could NOT be restored automatically — restore it from the backup',
};

function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

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

  const dismiss = useCallback(async () => {
    const res = await fetch('/api/update-status/ack', { method: 'POST' });
    if (res.ok) setStatus((s) => s && { ...s, acknowledged: true, updated: null });
  }, []);

  return { status, dismiss };
}

const knownVersion = (v?: string) => (v && v !== '0.0.0' ? v : null);

export default function UpdateBanner() {
  const app = useAppUpdate();
  const { status, dismiss } = useUpdateStatus();
  const [open, setOpen] = useState(false);

  const report = status?.report ?? null;
  const brain = status?.brain ?? report?.brainName;
  const failure = report && report.outcome !== 'migrated' && !status?.resolved ? report.outcome : null;
  const migrated = report?.outcome === 'migrated' && !status?.acknowledged ? report : null;
  const updated = status?.updated ?? null;

  const latest = app.status?.latest;
  const busy = app.phase === 'installing' || app.phase === 'restarting';
  const offer = !!latest && (busy || app.phase === 'installed-restart-needed' || !!app.status?.available);

  // The outcome: the update this host runs, and the migration it brought along.
  let outcome: string | null = null;
  if (!failure && (updated || migrated)) {
    const version = updated?.to ?? knownVersion(migrated?.codeVersion);
    const head = !version ? '' : updated?.outcome === 'rolled_back' ? `Rolled back to v${version}.` : `Updated to v${version}.`;
    const brainLine = migrated ? `Your brain “${brain}” successfully migrated from schema v${migrated.from} to v${migrated.to}.` : '';
    outcome = [head, brainLine].filter(Boolean).join(' ');
  }

  return (
    <>
      {failure && report && (
        <Banner
          tone="destructive"
          icon={XCircle}
          detail={report.error && `Reason: ${report.error}`}
          actions={
            <>
              <BannerLink icon={open ? ChevronDown : ChevronRight} onClick={() => setOpen((v) => !v)}>
                {open ? 'Hide report' : 'Show report'}
              </BannerLink>
              {report.backupPath && (
                <BannerLink icon={FolderSearch} onClick={() => void fetch('/api/update-status/reveal-backup', { method: 'POST' })}>
                  Reveal backup
                </BannerLink>
              )}
            </>
          }
          below={open && (
            <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-background/70 p-2 font-mono text-[11px] text-foreground">
              {JSON.stringify(report, null, 2)}
            </pre>
          )}
        >
          {`Update${knownVersion(report.codeVersion) ? ` to v${report.codeVersion}` : ''} failed: your brain “${brain}” is still on schema v${report.from} and ${FAILURE_STATE[failure]}. The brain is offline until the update succeeds.`}
        </Banner>
      )}

      {offer && latest && (
        <Banner
          tone="info"
          icon={ArrowUpCircle}
          busy={busy}
          detail={app.error}
          actions={app.phase === 'idle' && (
            <>
              {latest.url && <BannerLink href={latest.url} icon={ExternalLink}>Release notes</BannerLink>}
              <BannerButton onClick={() => void app.apply(latest.version)}>Update</BannerButton>
            </>
          )}
        >
          {app.phase === 'installing'
            ? `Installing v${latest.version}…`
            : app.phase === 'restarting'
              ? `Restarting into v${latest.version} — the page reloads when it's back.`
              : app.phase === 'installed-restart-needed'
                ? `v${latest.version} is installed — restart the cockpit to use it.`
                : `EML Cockpit v${latest.version} is available — you have v${app.status?.current}.`}
        </Banner>
      )}

      {outcome && !busy && (
        <Banner tone="success" icon={CheckCircle2} onDismiss={() => void dismiss()}>
          {outcome}
        </Banner>
      )}
    </>
  );
}
