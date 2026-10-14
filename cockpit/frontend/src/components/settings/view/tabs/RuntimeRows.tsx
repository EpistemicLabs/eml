// Settings › Models — the cockpit's own copy of an agent CLI (host
// managed-runtime.ts): version, background updates, check now, roll back.
// Independent of any copy installed on this computer; updates apply to new
// sessions, running ones keep their version. Rows for a SettingsCard.
import { useRuntimeAction, type AgentProviderInfo, type RuntimeResult } from '@/lib/providers';
import { Button } from '@/shared/view/ui';
import SettingsRow from '../SettingsRow';
import SettingsToggle from '../SettingsToggle';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

function resultLabel(result: RuntimeResult | null): string | null {
  if (!result) return null;
  switch (result.outcome) {
    case 'installed': return `Installed ${result.to}.`;
    case 'updated': return `Updated ${result.from} → ${result.to} — new sessions use it.`;
    case 'up_to_date': return 'Up to date.';
    case 'rolled_back': return `Went back ${result.from} → ${result.to}; ${result.from} is skipped from now on.`;
    case 'failed': return `Last attempt failed: ${result.error ?? 'unknown error'}. The active version stays in use.`;
  }
}

type RuntimeRowsProps = {
  provider: AgentProviderInfo;
  /** Shown while nothing is installed — what "Set up now" will do. */
  notSetUpHint?: string;
};

export default function RuntimeRows({ provider, notSetUpHint }: RuntimeRowsProps) {
  const action = useRuntimeAction(provider.id);
  const state = provider.runtime;
  const busy = action.isPending;
  const error = action.isError ? action.error.message : null;
  const result = resultLabel(state.lastResult);

  return (
    <>
      <SettingsRow
        label={state.current ? `Version ${state.current}` : 'Not set up'}
        description={
          state.current || !notSetUpHint
            ? [`Channel: ${state.channel}`, `last check: ${when(state.lastCheckAt)}`].join(' · ')
            : notSetUpHint
        }
      >
        <Button variant="ghost" size="sm" onClick={() => action.mutate({ check: true })} disabled={busy}>
          {busy ? (state.current ? 'Checking…' : 'Setting up…') : state.current ? 'Check now' : 'Set up now'}
        </Button>
      </SettingsRow>
      {state.current && (
        <SettingsRow
          label="Update in the background"
          description={
            state.autoUpdate === false
              ? 'Off — the cockpit only updates when you press Check now.'
              : 'On — the cockpit checks every few hours and switches new sessions to a verified new version.'
          }
        >
          <SettingsToggle
            checked={state.autoUpdate !== false}
            onChange={(checked: boolean) => action.mutate({ autoUpdate: checked })}
            ariaLabel={`Update ${provider.label} in the background`}
            disabled={busy}
          />
        </SettingsRow>
      )}
      {state.previous && (
        <SettingsRow
          label={`Previous version ${state.previous}`}
          description="Go back if the current version misbehaves. The current one is then skipped by updates."
        >
          <Button variant="ghost" size="sm" onClick={() => action.mutate({ rollback: true })} disabled={busy}>
            Go back
          </Button>
        </SettingsRow>
      )}
      {(result || error) && (
        <p className={`px-4 py-3 text-sm ${error || state.lastResult?.outcome === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
          {error ?? result}
        </p>
      )}
    </>
  );
}
