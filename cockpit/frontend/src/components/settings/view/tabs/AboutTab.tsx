// Settings › About: logo, name and version badge; the numbers come from the
// host (GET /api/about) — cockpit version, Claude Code version (the config dir
// shows in Settings › Brain › Paths). The License section carries the AGPL
// §5(d) legal notice.
import { Brain } from 'lucide-react';

import { useState } from 'react';

import { useAboutInfo } from '@/hooks/useAboutInfo';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

export default function AboutTab() {
  const { info, failed } = useAboutInfo();

  const versionLabel = info ? `v${info.version}` : failed ? 'unknown' : '…';

  return (
    <div className="space-y-6">
      {/* Logo + name + version */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/90 shadow-sm">
          <Brain className="h-5 w-5 text-primary-foreground" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-foreground">EML Cockpit</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {versionLabel}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Claude Code sessions with a brain — local, isolated, yours.
          </p>
        </div>
      </div>

      <SettingsSection title="Runtime">
        <SettingsCard divided>
          <SettingsRow label="Claude Code" description="The CLI the cockpit spawns for every session">
            <Mono>{info?.claudeVersion ?? '—'}</Mono>
          </SettingsRow>
          <SettingsRow label="Node" description="Runtime of the cockpit host">
            <Mono>{info?.node ?? '—'}</Mono>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="License">
        <SettingsCard>
          <div className="space-y-2 px-4 py-4 text-sm text-muted-foreground">
            <p>
              EML Cockpit is free software under the GNU Affero General Public License v3.0
              (AGPL-3.0-only). Copyright © 2026 Dominik Tilman and Lasse Lung.
            </p>
            <p>Third-party notices: NOTICE in the eml-cockpit package.</p>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Updates">
        <UpdatesCard />
      </SettingsSection>
    </div>
  );
}

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`block font-mono text-xs text-foreground ${className ?? ''}`}>
      {children}
    </span>
  );
}

const TOKEN_SOURCE: Record<'file' | 'gh' | 'none', string> = {
  file: 'Connected with a token',
  gh: 'Connected through the GitHub CLI (gh)',
  none: 'No token',
};

function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

/**
 * Settings › About › Updates: the release the host last saw on GitHub, check
 * now, install, go back, and the GitHub token (write-only: the browser can set
 * or remove it, never read it). A dev cockpit runs from source and has no updater.
 */
function UpdatesCard() {
  const { status, phase, error, check, apply, rollback, setToken } = useAppUpdate();
  const [token, setTokenInput] = useState('');

  if (!status) {
    return (
      <SettingsCard>
        <div className="px-4 py-4 text-sm text-muted-foreground">…</div>
      </SettingsCard>
    );
  }
  if (!status.managed) {
    return (
      <SettingsCard>
        <div className="px-4 py-4 text-sm text-muted-foreground">
          This cockpit runs from source (development) — update it with git. Installed cockpits update here.
        </div>
      </SettingsCard>
    );
  }

  const busy = phase !== 'idle' || status.busy;
  const button = 'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-foreground/5 disabled:opacity-50';

  return (
    <SettingsCard divided>
      <SettingsRow
        label="Release"
        description={
          status.latest
            ? `Latest: v${status.latest.version} · last checked ${formatTime(status.lastCheckAt)}`
            : `No release seen yet · last checked ${formatTime(status.lastCheckAt)}`
        }
      >
        <div className="flex items-center gap-2">
          {status.available && status.latest && (
            <button type="button" className={button} disabled={busy} onClick={() => void apply(status.latest!.version)}>
              Update to v{status.latest.version}
            </button>
          )}
          <button type="button" className={button} disabled={busy} onClick={() => void check()}>
            {phase === 'checking' ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </SettingsRow>
      {(status.previous || status.rollbackBlocked) && (
        <SettingsRow
          label="Previous version"
          description={status.rollbackBlocked ?? `v${status.previous} is kept — go back if this version misbehaves.`}
        >
          <button type="button" className={button} disabled={busy || !status.canRollback} onClick={() => rollback()}>
            Go back
          </button>
        </SettingsRow>
      )}
      <SettingsRow
        label="GitHub"
        description={`${TOKEN_SOURCE[status.token.source]}. Updates need no token; an optional read-only token raises GitHub's rate limit.`}
      >
        {status.token.source === 'file' ? (
          <button type="button" className={button} disabled={busy} onClick={() => void setToken(null)}>
            Remove token
          </button>
        ) : (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void setToken(token).then((ok) => { if (ok) setTokenInput(''); });
            }}
          >
            <input
              type="password"
              autoComplete="off"
              placeholder="github_pat_…"
              value={token}
              onChange={(e) => setTokenInput(e.target.value)}
              className="w-44 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-foreground/40"
            />
            <button type="submit" className={button} disabled={busy || !token.trim()}>
              Save
            </button>
          </form>
        )}
      </SettingsRow>
      {(error || status.error || status.lastResult?.outcome === 'failed') && (
        <div className="px-4 py-3 text-xs text-destructive">
          {error ?? status.error ?? `Last update failed: ${status.lastResult?.error ?? 'unknown error'}`}
        </div>
      )}
      {(phase === 'installing' || phase === 'restarting') && (
        <div className="px-4 py-3 text-xs text-muted-foreground">
          {phase === 'installing' ? 'Installing…' : 'Restarting — the page reloads when the cockpit is back.'}
        </div>
      )}
    </SettingsCard>
  );
}
