// Settings › Models › Codex (beta), in the order every provider uses:
// sign-in, permissions, version. Until the cockpit's own Codex CLI is set up,
// only the set-up row shows.
import { useState } from 'react';

import { useSetProviderSettings, type AgentProviderInfo } from '@/lib/providers';
import { Button } from '@/shared/view/ui';
import { getActivePane, openInPane } from '@/stores/usePaneStore';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsSegmented from '../SettingsSegmented';
import SettingsToggle from '../SettingsToggle';
import RuntimeRows from './RuntimeRows';

type CodexPermissionMode = 'auto' | 'ask' | 'off';

const RUNTIME_DESCRIPTION =
  'The cockpit runs its own Codex CLI, separate from any Codex installed on this computer, with a sign-in and settings of its own. Updates apply to new sessions; running sessions keep their version.';
const NOT_SET_UP_HINT =
  'Downloads the Codex CLI from the npm registry into the cockpit home (a few hundred MB) and verifies it.';

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

export default function CodexSettings({ codex, onCloseSettings }: { codex: AgentProviderInfo; onCloseSettings?: () => void }) {
  const setSettings = useSetProviderSettings('codex');
  const [error, setError] = useState<string | null>(null);
  const mode: CodexPermissionMode =
    PERMISSION_MODES.find((option) => option.value === codex.settings?.permissionMode)?.value ?? 'auto';
  const sandboxed = mode !== 'off';
  const network = codex.settings?.sandboxNetwork === true;

  if (!codex.version) {
    return (
      <SettingsSection title="Set up Codex (beta)" description={RUNTIME_DESCRIPTION}>
        <SettingsCard divided>
          <RuntimeRows provider={codex} notSetUpHint={NOT_SET_UP_HINT} />
        </SettingsCard>
      </SettingsSection>
    );
  }

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
    <div className="space-y-6">
      <SettingsSection title="Sign-in" description="The sign-in belongs to this cockpit only — a Codex you already use on this computer is not touched.">
        <SettingsCard divided>
          <SettingsRow
            label="Codex sign-in"
            description={codex.signedIn ? 'Signed in.' : 'Not signed in yet. Opens a Codex session; its first screen is Codex’s own sign-in.'}
          >
            {!codex.signedIn && <Button size="sm" onClick={signIn}>Sign in</Button>}
          </SettingsRow>
          <div className="px-4 py-3 text-sm text-muted-foreground">
            The first Codex session asks once whether to trust the cockpit’s hooks — choose “Trust all”; they report the
            session’s state to the cockpit and load your brain.
          </div>
          {error && <p className="px-4 pb-4 text-sm text-destructive">{error}</p>}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Permissions"
        description="How much a Codex session may do without asking. Applies to sessions started from now on."
      >
        <SettingsCard divided>
          <SettingsRow label="Before risky actions" description={PERMISSION_MODES.find((option) => option.value === mode)?.description}>
            <SettingsSegmented
              value={mode}
              options={PERMISSION_MODES}
              onChange={(value) => setSettings.mutate({ permissionMode: value })}
              ariaLabel="Codex permissions"
              disabled={setSettings.isPending}
            />
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

      <SettingsSection title="Version" description={RUNTIME_DESCRIPTION}>
        <SettingsCard divided>
          <RuntimeRows provider={codex} />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
