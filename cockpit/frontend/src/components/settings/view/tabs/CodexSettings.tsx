// Settings › Models › Codex (beta), in the order every provider uses:
// sign-in (ChatGPT's device code, run by the host through app-server —
// AgentSignIn), permissions, version. Until the cockpit's own Codex CLI is set up,
// only the set-up row shows.
import { useSetProviderSettings, type AgentProviderInfo } from '@/lib/providers';
import { Switch } from '@/shared/view/ui';
import AgentSignIn from '@/components/sign-in/AgentSignIn';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsSegmented from '../SettingsSegmented';
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

// Host: providers/codex/settings.ts reasoningEffort. The ids are Codex's own; a model that does not take
// the chosen one runs with its default, and a chat session can choose its own in its status bar.
const EFFORTS: ReadonlyArray<{ value: string; label: string; description: string }> = [
  { value: 'default', label: 'Default', description: 'Default — each model thinks as hard as it does by default.' },
  { value: 'low', label: 'Low', description: 'Low — fast answers with lighter reasoning.' },
  { value: 'medium', label: 'Medium', description: 'Medium — balances speed and depth for everyday tasks.' },
  { value: 'high', label: 'High', description: 'High — more depth for complex problems; slower and uses more of your limits.' },
  { value: 'xhigh', label: 'Extra high', description: 'Extra high — the most depth most models offer; slowest, and uses the most of your limits.' },
];

export default function CodexSettings({ codex }: { codex: AgentProviderInfo; onCloseSettings?: () => void }) {
  const setSettings = useSetProviderSettings('codex');
  const mode: CodexPermissionMode =
    PERMISSION_MODES.find((option) => option.value === codex.settings?.permissionMode)?.value ?? 'auto';
  const sandboxed = mode !== 'off';
  const network = codex.settings?.sandboxNetwork === true;
  const chatView = codex.settings?.chatView === true;
  const effort = EFFORTS.find((option) => option.value === codex.settings?.reasoningEffort) ?? EFFORTS[0];

  if (!codex.version) {
    return (
      <SettingsSection title="Set up Codex (beta)" description={RUNTIME_DESCRIPTION}>
        <SettingsCard divided>
          <RuntimeRows provider={codex} notSetUpHint={NOT_SET_UP_HINT} />
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="Sign-in" description="The sign-in belongs to this cockpit only — a Codex you already use on this computer is not touched.">
        <SettingsCard divided>
          <SettingsRow
            label="Codex sign-in"
            description={codex.signedIn ? 'Signed in.' : 'Not signed in yet. Sign in with your ChatGPT account: the cockpit shows a code to enter on OpenAI’s sign-in page.'}
          >
            {null}
          </SettingsRow>
          {!codex.signedIn && (
            <div className="px-4 py-4">
              <AgentSignIn provider="codex" label="Sign in with ChatGPT" onDone={() => {}} />
            </div>
          )}
          <div className="px-4 py-3 text-body text-muted-foreground">
            The first Codex session asks once whether to trust the cockpit’s hooks — choose “Trust all”; they report the
            session’s state to the cockpit and load your brain.
          </div>
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
            <Switch
              checked={network}
              onChange={(checked: boolean) => setSettings.mutate({ sandboxNetwork: checked })}
              ariaLabel="Network in the Codex sandbox"
              disabled={setSettings.isPending || !sandboxed}
            />
          </SettingsRow>
          <div className="px-4 py-3 text-body text-muted-foreground">
            Worker sessions opened by another session always run in Auto — nobody is watching them.
          </div>
          {setSettings.isError && <p className="px-4 pb-4 text-body text-stopped-ink">{setSettings.error.message}</p>}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Chat view (beta)" description="Run Codex sessions in the chat view, next to the terminal. Applies to sessions opened from now on.">
        <SettingsCard divided>
          <SettingsRow
            label="Codex in the chat view"
            description={
              chatView
                ? 'On — a Codex session can open in the chat view, workers run there, and other sessions can send it messages.'
                : 'Off — Codex sessions run in the terminal only.'
            }
          >
            <Switch
              checked={chatView}
              onChange={(checked: boolean) => setSettings.mutate({ chatView: checked })}
              ariaLabel="Codex in the chat view"
              disabled={setSettings.isPending}
            />
          </SettingsRow>
          <SettingsRow
            label="Reasoning effort"
            description={`${effort.description} What a chat session starts with; it can choose its own next to the model.`}
          >
            <SettingsSegmented
              value={effort.value}
              options={EFFORTS}
              onChange={(value) => setSettings.mutate({ reasoningEffort: value })}
              ariaLabel="Codex reasoning effort"
              disabled={setSettings.isPending || !chatView}
            />
          </SettingsRow>
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
