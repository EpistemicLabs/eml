// Settings › About: logo and name, then every version in one
// read-only list with a Copy button for bug reports — cockpit, Claude Code and
// Node from the host (GET /api/about), Codex and Qwen Code from the providers. Managing the
// agent CLIs stays in Settings › Models. The License section carries the AGPL
// §5(d) legal notice.
import { Brain } from 'lucide-react';

import { useState } from 'react';

import { useAboutInfo } from '@/hooks/useAboutInfo';
import { useProviders } from '@/lib/providers';
import { durationMs } from '@/lib/time';
import { cn } from '@/lib/utils';
import { Button } from '@/shared/view/ui';
import { copyTextToClipboard } from '@/utils/clipboard';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import { SETTINGS_BUTTON_CLASS, SETTINGS_INPUT_CLASS } from '../../constants/constants';

export default function AboutTab() {
  const { info, failed } = useAboutInfo();

  const { data: providers } = useProviders();
  const [copied, setCopied] = useState(false);

  const codexVersion = providers?.find((provider) => provider.id === 'codex')?.version ?? null;
  const qwenVersion = providers?.find((provider) => provider.id === 'qwen')?.version ?? null;
  const versions: Array<[string, string]> = info
    ? [
        ['EML Cockpit', `${info.version}${info.runMode === 'dev' ? ' (dev)' : ''}`],
        ['Claude Code', info.claudeVersion || '—'],
        ...(codexVersion ? [['Codex', codexVersion] as [string, string]] : []),
        ...(qwenVersion ? [['Qwen Code', qwenVersion] as [string, string]] : []),
        ['Node', info.node],
        ['OS', navigator.platform || '—'],
      ]
    : [];

  const copyVersions = async () => {
    if (await copyTextToClipboard(versions.map(([name, value]) => `${name}: ${value}`).join('\n'))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), durationMs('--duration-feedback'));
    }
  };

  return (
    <div className="space-y-6">
      {/* Logo + name */}
      <div className="flex items-center gap-3">
        <div className="flex size-10 flex-shrink-0 items-center justify-center rounded-xl bg-foreground shadow-card">
          <Brain aria-hidden className="size-5 text-background" />
        </div>
        <span className="text-title font-semibold text-foreground">EML Cockpit</span>
      </div>

      <SettingsSection
        title="Versions"
        description="Paste these into a bug report."
      >
        <SettingsCard divided>
          {versions.length === 0 && <div className="px-4 py-4 text-body text-muted-foreground">{failed ? 'unknown' : '…'}</div>}
          {versions.map(([name, value]) => (
            <SettingsRow key={name} label={name}>
              <Mono>{value}</Mono>
            </SettingsRow>
          ))}
          {versions.length > 0 && (
            <div className="flex justify-end px-4 py-3">
              <Button variant="outline" size="sm" onClick={() => void copyVersions()}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="License">
        <SettingsCard>
          <div className="space-y-2 px-4 py-4 text-body text-muted-foreground">
            <p>EML Cockpit is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).</p>
            <p>Copyright © 2026 Dominik Tilman and Lasse Lung.</p>
            <p>
              <a href="https://github.com/EpistemicLabs/eml/blob/main/LICENSE" target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-(--focus-offset) focus-visible:outline-ring">
                Read the license
              </a>
            </p>
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
    <span className={`block font-code text-ui text-foreground ${className ?? ''}`}>
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
        <div className="px-4 py-4 text-body text-muted-foreground">…</div>
      </SettingsCard>
    );
  }
  if (!status.managed) {
    return (
      <SettingsCard>
        <div className="px-4 py-4 text-body text-muted-foreground">
          This cockpit runs from source (development) — update it with git. Installed cockpits update here.
        </div>
      </SettingsCard>
    );
  }

  const busy = phase !== 'idle' || status.busy;
  const button = SETTINGS_BUTTON_CLASS;

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
              className={cn(SETTINGS_INPUT_CLASS, 'w-44 font-code')}
            />
            <button type="submit" className={button} disabled={busy || !token.trim()}>
              Save
            </button>
          </form>
        )}
      </SettingsRow>
      {(error || status.error || status.lastResult?.outcome === 'failed') && (
        <div className="px-4 py-3 text-ui text-stopped-ink">
          {error ?? status.error ?? `Last update failed: ${status.lastResult?.error ?? 'unknown error'}`}
        </div>
      )}
      {(phase === 'installing' || phase === 'restarting') && (
        <div className="px-4 py-3 text-ui text-muted-foreground">
          {phase === 'installing' ? 'Installing…' : 'Restarting — the page reloads when the cockpit is back.'}
        </div>
      )}
    </SettingsCard>
  );
}
