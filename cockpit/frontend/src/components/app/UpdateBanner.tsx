// The update banner (decision app-update-flow): one strip for the whole
// update, from "available" through installing and restarting to its outcome.
// "Available" comes from GET /api/app-update and stays until the update is
// installed; the outcome from GET /api/update-status — the in-app update this
// host runs and, per brain, its last schema migration. A space shows its own
// brain's migration only; a failure in another space is marked on the space
// switch. Success is green and can be dismissed. A failed migration is red and
// stays until the brain has caught up: it is the only place that says why the
// brain is offline. An in-app update's success is not a strip but a dialog
// over the page, with the notes of the releases it brought; closing it dismisses.
import { useState } from 'react';
import { ArrowUpCircle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, FolderSearch, XCircle } from 'lucide-react';

import { useAppUpdate } from '@/hooks/useAppUpdate';
import { dismissUpdateStatus, failedUnresolved, useUpdateStatus, type MigrationReport } from '@/stores/useUpdateStatusStore';
import { useActiveSpace } from '@/stores/useSpaceStore';
import { Banner, BannerButton, BannerLink } from './Banner';
import ReleaseNotesDialog from './ReleaseNotesDialog';

// What the failure means for the brain, per outcome.
const FAILURE_STATE: Record<Exclude<MigrationReport['outcome'], 'migrated'>, string> = {
  preflight_failed: 'was not changed',
  backup_failed: 'was not changed (no backup could be taken)',
  restored: 'was restored from the backup',
  brain_missing: 'has no data file on disk',
  restore_failed: 'could NOT be restored automatically — restore it from the backup',
};

const knownVersion = (v?: string) => (v && v !== '0.0.0' ? v : null);

export default function UpdateBanner() {
  const app = useAppUpdate();
  const status = useUpdateStatus();
  const space = useActiveSpace();
  const [open, setOpen] = useState(false);

  // The active space's brain only (space id = brain id).
  const own = space ? status?.brains[space.id] : undefined;
  const report = own?.report ?? null;
  const brain = own?.brain ?? report?.brainName;
  const failure = report && failedUnresolved(own) ? (report.outcome as Exclude<MigrationReport['outcome'], 'migrated'>) : null;
  const migrated = report?.outcome === 'migrated' && !own?.acknowledged ? report : null;
  const dismiss = () => { if (space) void dismissUpdateStatus(space.id); };
  const updated = status?.updated ?? null;

  const latest = app.status?.latest;
  const busy = app.phase === 'installing' || app.phase === 'restarting';
  const offer = !!latest && (busy || app.phase === 'installed-restart-needed' || !!app.status?.available);

  // The outcome: the update this host runs, and the migration it brought along.
  // An in-app update shows it in the "What's new" dialog, everything else here.
  const brainLine = migrated ? `Your brain “${brain}” successfully migrated from schema v${migrated.from} to v${migrated.to}.` : '';
  const whatsNew = !failure && !busy && updated?.outcome === 'updated' ? updated : null;
  let outcome: string | null = null;
  if (!failure && !whatsNew && (updated || migrated)) {
    const version = updated?.to ?? knownVersion(migrated?.codeVersion);
    const head = !version ? '' : updated?.outcome === 'rolled_back' ? `Rolled back to v${version}.` : `Updated to v${version}.`;
    outcome = [head, brainLine].filter(Boolean).join(' ');
  }

  return (
    <>
      {failure && report && (
        <Banner
          tone="destructive"
          icon={XCircle}
          dismissKey={`update-failed:${space?.id ?? ''}:${report.codeVersion ?? ''}:${report.from}:${failure}`}
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
            <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-card p-2 font-code text-caption text-foreground">
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
          dismissKey={`update-offer:${latest.version}`}
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
        <Banner tone="success" icon={CheckCircle2} onDismiss={dismiss}>
          {outcome}
        </Banner>
      )}
      {whatsNew && <ReleaseNotesDialog from={whatsNew.from} to={whatsNew.to} brainLine={brainLine} onClose={dismiss} />}
    </>
  );
}
