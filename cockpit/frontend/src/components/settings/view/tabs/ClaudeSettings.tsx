// Settings › Models › Claude Code, in the order every provider uses: sign-in,
// permissions, version, then the advanced setup-token. Sign-in default: the regular Claude Code sign-in, which the host
// runs here without a terminal (AgentSignIn) and Claude Code keeps in the
// config dir of the active space's sessions. The setup-token is for runtimes without a
// browser; it goes to the host once (PUT /api/agents/login) and is never read
// back — only a short prefix.
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import type { AgentProviderInfo } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { Button, Chip, FOCUS, Input, LABEL, Switch } from '@/shared/view/ui';
import { api } from '@/utils/api';
import AgentSignIn from '@/components/sign-in/AgentSignIn';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import RuntimeRows from './RuntimeRows';

type LoginMode = 'login' | 'token';
type PermissionMode = 'auto' | 'bypassPermissions';
type Account = { loggedIn: boolean; authMethod: string | null; subscriptionType: string | null; email: string | null };
type LoginStatus = {
  mode: LoginMode;
  /** The active space's own agent keeps its own login; the setup-token does not apply to it. Missing from an older host. */
  ownLogin?: boolean;
  permissionMode: PermissionMode;
  token: { set: boolean; prefix: string | null };
  account: Account | null;
};

function accountLabel(status: LoginStatus | null): string {
  if (!status) return 'Checking…';
  const account = status.account;
  if (!account) return 'Unknown — Claude Code did not report a status.';
  if (!account.loggedIn) return 'Not signed in yet.';
  const plan = account.subscriptionType ? `Claude ${account.subscriptionType[0].toUpperCase()}${account.subscriptionType.slice(1)}` : null;
  const via = account.authMethod === 'oauth_token' ? 'setup-token' : account.authMethod;
  return [account.email, plan, via ? `via ${via}` : null].filter(Boolean).join(' · ') || 'Signed in.';
}

export default function ClaudeSettings({ claude }: { claude: AgentProviderInfo }) {
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const load = useCallback(async (refresh = false) => {
    try {
      const response = await api.claudeLogin(refresh);
      if (response.ok) setStatus((await response.json()) as LoginStatus);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (request: () => Promise<Response>, onOk?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const response = await request();
      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? `Could not save (HTTP ${response.status})`);
        return;
      }
      setStatus(body as LoginStatus);
      onOk?.();
    } catch {
      setError('The cockpit host is not reachable.');
    } finally {
      setBusy(false);
    }
  };

  const saveToken = () => run(() => api.setClaudeLogin(token), () => { setToken(''); setEditing(false); });
  const removeToken = () => run(() => api.clearClaudeLogin());
  const setMode = (mode: LoginMode) => run(() => api.setLoginMode(mode));
  const setPermissionMode = (mode: PermissionMode) => run(() => api.setPermissionMode(mode));
  const bypass = status?.permissionMode === 'bypassPermissions';

  // The setup-token signs in the shared config's sessions only, never a space's own agent.
  const tokenMode = status?.mode === 'token' && status.ownLogin !== true;
  // The switch itself is the cockpit's, whichever space is active.
  const tokenModeOn = status?.mode === 'token';
  const showTokenForm = editing || status?.token.set === false;
  // A token in use keeps the advanced part open — it decides how sessions sign in.
  const showAdvanced = advancedOpen || tokenModeOn;

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Sign-in"
        description="Sessions run on your Claude subscription. The sign-in belongs to this cockpit only — your own Claude Code setup is not touched."
      >
        <SettingsCard divided>
          <SettingsRow
            label={tokenMode ? 'Signed in via setup-token' : 'Claude Code login'}
            description={accountLabel(status)}
          >
            <Button variant="ghost" size="sm" onClick={() => void load(true)} disabled={busy}>
              Refresh
            </Button>
          </SettingsRow>
          {!tokenMode && status?.account?.loggedIn !== true && (
            <div className="space-y-3 px-4 py-4">
              <p className="text-body text-muted-foreground">
                {claude.version
                  ? status?.ownLogin
                    ? "Sign in to Claude for this space's agent: it keeps a login of its own."
                    : 'Sign in to Claude with your subscription.'
                  : 'Claude Code is not set up yet — see Version below.'}
              </p>
              <AgentSignIn provider="claude" label="Sign in to Claude" disabled={busy || !claude.version} onDone={() => void load(true)} />
            </div>
          )}
          {error && !showAdvanced && <p className="px-4 pb-4 text-body text-stopped-ink">{error}</p>}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Permissions"
        description="How much a Claude Code session may do without asking. Applies to sessions started from now on."
      >
        <SettingsCard divided>
          <SettingsRow
            label="Ask before risky actions (auto mode)"
            description={
              bypass
                ? 'Off — your sessions never ask, they run every command and edit directly. Only for throwaway work.'
                : 'On (recommended) — Claude Code approves what it judges safe and asks before risky actions; the session then shows as waiting.'
            }
          >
            <Switch
              checked={!bypass}
              onChange={(checked: boolean) => void setPermissionMode(checked ? 'auto' : 'bypassPermissions')}
              ariaLabel="Ask before risky actions"
              disabled={busy || status === null}
            />
          </SettingsRow>
          <div className="px-4 py-3 text-body text-muted-foreground">
            Worker sessions opened by another session always run in auto mode — nobody is watching them.
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Version"
        description="The cockpit runs its own Claude Code, separate from any Claude Code installed on this computer. Updates apply to new sessions; running sessions keep their version."
      >
        <SettingsCard divided>
          <RuntimeRows provider={claude} />
        </SettingsCard>
      </SettingsSection>

      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          disabled={tokenModeOn}
          aria-expanded={showAdvanced}
          className={cn('flex min-h-(--target-min) items-center gap-1 hover:text-foreground disabled:hover:text-muted-foreground', LABEL, FOCUS)}
        >
          <ChevronRight aria-hidden className={cn('size-3.5 transition-transform duration-(--duration-fast)', showAdvanced && 'rotate-90')} />
          Advanced: setup-token
        </button>
        {showAdvanced && (
          <>
            <p className="text-body text-muted-foreground">
              A long-lived token from <code className="font-code text-ui text-foreground">claude setup-token</code> for
              runtimes without a browser (servers, tests). Also billed to your subscription, but Claude Code then shows
              “Claude API” and its default model.
            </p>
            <SettingsCard divided>
              <SettingsRow
                label="Use the token for sessions"
                description={tokenModeOn ? 'On — new sessions use the setup-token instead of the login.' : 'Off — new sessions use the Claude Code login.'}
              >
                <Switch
                  checked={tokenModeOn}
                  onChange={(checked: boolean) => void setMode(checked ? 'token' : 'login')}
                  ariaLabel="Use the setup-token for sessions"
                  disabled={busy || (!tokenModeOn && !status?.token.set)}
                />
              </SettingsRow>

              <SettingsRow
                label="Token"
                description={status?.token.set ? 'Stored in the cockpit home (owner-only), never shown again.' : 'None stored.'}
              >
                {status?.token.set ? (
                  <div className="flex items-center gap-2">
                    <span className="font-code text-ui text-foreground">{status.token.prefix}</span>
                    {!editing && (
                      <Button variant="ghost" size="sm" onClick={() => setEditing(true)} disabled={busy}>
                        Replace
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => void removeToken()} disabled={busy}>
                      Remove
                    </Button>
                  </div>
                ) : (
                  <Chip className="py-0.5">none</Chip>
                )}
              </SettingsRow>

              {showTokenForm && (
                <div className="space-y-3 px-4 py-4">
                  <p className="text-body text-muted-foreground">
                    Run <code className="font-code text-ui text-foreground">claude setup-token</code> in a terminal, sign in,
                    and paste the token it prints (it starts with <code className="font-code text-ui text-foreground">sk-ant-oat</code>).
                  </p>
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(event) => { event.preventDefault(); if (token.trim()) void saveToken(); }}
                  >
                    <Input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="sk-ant-oat…"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      className="flex-1 font-code text-ui"
                    />
                    <Button type="submit" size="sm" disabled={busy || !token.trim()}>
                      Save
                    </Button>
                    {editing && status?.token.set && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(false); setToken(''); setError(null); }}>
                        Cancel
                      </Button>
                    )}
                  </form>
                </div>
              )}
              {error && <p className="px-4 pb-4 text-body text-stopped-ink">{error}</p>}
            </SettingsCard>
          </>
        )}
      </div>
    </div>
  );
}
