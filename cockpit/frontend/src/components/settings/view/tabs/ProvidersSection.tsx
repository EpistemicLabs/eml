// Settings › Models — the agent CLIs sessions can run with: which one new
// sessions start with, the cockpit's own copy of each (RuntimeRows), and
// Codex's sign-in and permissions. Claude Code's sign-in and permissions have
// their own sections below (ModelsTab).
import { useState } from 'react';

import { useProviders, useSetDefaultProvider, useSetProviderSettings, type AgentProviderInfo } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { Button } from '@/shared/view/ui';
import { getActivePane, openInPane } from '@/stores/usePaneStore';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import RuntimeRows from './RuntimeRows';

type CodexPermissionMode = 'auto' | 'ask' | 'off';

// Host: providers/codex/settings.ts.
const PERMISSION_MODES: ReadonlyArray<{ value: CodexPermissionMode; label: string; description: string }> = [
  {
    value: 'auto',
    label: 'Auto',
    description:
      'Auto (recommended) — Codex works in its sandbox: it can only write inside the project folder. When it wants to go beyond that, a second model reviews the request and allows what you asked for; anything else comes to you, and the session then shows as waiting.',
  },
  {
    value: 'ask',
    label: 'Ask',
    description:
      'Ask — Codex works in its sandbox, and every request to go beyond it comes to you; the session then shows as waiting.',
  },
  {
    value: 'off',
    label: 'Off',
    description:
      'Off — no sandbox and no questions: your sessions run every command and edit directly, anywhere on this computer. Only for throwaway work.',
  },
];

function CodexSections({ codex, onCloseSettings }: { codex: AgentProviderInfo; onCloseSettings?: () => void }) {
  const setSettings = useSetProviderSettings('codex');
  const [error, setError] = useState<string | null>(null);
  const mode: CodexPermissionMode =
    PERMISSION_MODES.find((option) => option.value === codex.settings?.permissionMode)?.value ?? 'auto';
  const sandboxed = mode !== 'off';
  const network = codex.settings?.sandboxNetwork === true;

  // Codex signs in on its own first screen: open a Codex session and the user
  // lands on it. In the active pane's project — an empty pane that already has
  // a project counts, openInPane reuses it.
  const signIn = () => {
    const projectId = getActivePane()?.projectId ?? null;
    if (!projectId) {
      setError('Open a project first — the sign-in runs in a session of that project.');
      return;
    }
    openInPane({ surface: 'terminal', projectId, provider: 'codex' });
    onCloseSettings?.();
  };

  return (
    <>
      <SettingsSection
        title="Codex"
        description="The cockpit runs its own Codex CLI, separate from any Codex installed on this computer, with a sign-in and settings of its own. Updates apply to new sessions; running sessions keep their version."
      >
        <SettingsCard divided>
          <RuntimeRows
            provider={codex}
            notSetUpHint="Downloads the Codex CLI from the npm registry into the cockpit home (a few hundred MB) and verifies it."
          />
          {codex.version && (
            <SettingsRow
              label="Codex sign-in"
              description={codex.signedIn ? 'Signed in.' : 'Not signed in yet. Opens a Codex session; its first screen is Codex’s own sign-in.'}
            >
              {!codex.signedIn && <Button size="sm" onClick={signIn}>Sign in</Button>}
            </SettingsRow>
          )}
          {codex.version && (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              The first Codex session asks once whether to trust the cockpit’s hooks — choose “Trust all”; they report the
              session’s state to the cockpit and load your brain.
            </div>
          )}
          {error && <p className="px-4 pb-4 text-sm text-destructive">{error}</p>}
        </SettingsCard>
      </SettingsSection>

      {codex.version && (
        <SettingsSection
          title="Codex permissions"
          description="How much a Codex session may do without asking. Applies to sessions started from now on."
        >
          <SettingsCard divided>
            <SettingsRow label="Before risky actions" description={PERMISSION_MODES.find((option) => option.value === mode)?.description}>
              <div
                role="radiogroup"
                aria-label="Codex permissions"
                className="inline-flex items-center gap-0.5 rounded-full border border-border bg-muted p-0.5"
              >
                {PERMISSION_MODES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={mode === option.value}
                    disabled={setSettings.isPending}
                    onClick={() => setSettings.mutate({ permissionMode: option.value })}
                    className={cn(
                      'h-6 cursor-pointer rounded-full px-3 text-xs font-medium transition-colors disabled:cursor-default',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-muted',
                      mode === option.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </SettingsRow>
            <SettingsRow
              label="Network in the sandbox"
              description={
                !sandboxed
                  ? 'Not used — without the sandbox, commands have network access anyway.'
                  : network
                    ? 'On — commands in the sandbox can reach the network (package installs, git push, any other host) without a request.'
                    : 'Off — commands in the sandbox have no network; one that needs it is a request to go beyond the sandbox.'
              }
            >
              <SettingsToggle
                checked={network}
                onChange={(checked: boolean) => setSettings.mutate({ sandboxNetwork: checked })}
                ariaLabel="Network in the Codex sandbox"
                disabled={setSettings.isPending || !sandboxed}
              />
            </SettingsRow>
            <div className="px-4 py-3 text-sm text-muted-foreground">
              Worker sessions opened by another session always run in Auto — nobody is watching them.
            </div>
            {setSettings.isError && <p className="px-4 pb-4 text-sm text-destructive">{setSettings.error.message}</p>}
          </SettingsCard>
        </SettingsSection>
      )}
    </>
  );
}

export default function ProvidersSection({ onCloseSettings }: { onCloseSettings?: () => void }) {
  const { data: providers, isError } = useProviders({ refresh: true });
  const setDefault = useSetDefaultProvider();
  const claude = providers?.find((provider) => provider.id === 'claude');
  const codex = providers?.find((provider) => provider.id === 'codex');

  return (
    <>
      <SettingsSection
        title="Agent"
        description="The agent CLI a new session starts with. A session keeps the one it was started with; the “+” in the sidebar starts one with another."
      >
        <SettingsCard divided>
          {(providers ?? []).map((provider) => (
            <SettingsRow
              key={provider.id}
              label={provider.label}
              description={provider.isDefault ? 'New sessions start with this one.' : provider.version ? undefined : 'Not set up.'}
            >
              {provider.isDefault ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">default</span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!provider.version || setDefault.isPending}
                  onClick={() => setDefault.mutate(provider.id)}
                >
                  Make default
                </Button>
              )}
            </SettingsRow>
          ))}
          {!providers && <p className="px-4 py-3 text-sm text-muted-foreground">{isError ? 'The cockpit host is not reachable.' : 'Checking…'}</p>}
          {setDefault.isError && <p className="px-4 py-3 text-sm text-destructive">{setDefault.error.message}</p>}
        </SettingsCard>
      </SettingsSection>

      {claude && (
        <SettingsSection
          title="Claude Code"
          description="The cockpit runs its own Claude Code, separate from any Claude Code installed on this computer. Updates apply to new sessions; running sessions keep their version."
        >
          <SettingsCard divided>
            <RuntimeRows provider={claude} />
          </SettingsCard>
        </SettingsSection>
      )}

      {codex && <CodexSections codex={codex} onCloseSettings={onCloseSettings} />}
    </>
  );
}
