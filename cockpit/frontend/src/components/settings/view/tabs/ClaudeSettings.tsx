// Settings › Models › Claude Code, in the order every provider uses: sign-in,
// permissions, version, then Claude Code's own display switch and the advanced
// setup-token. Sign-in default: the regular Claude Code sign-in (/login), kept
// in the cockpit's own config dir. The setup-token is for runtimes without a
// browser; it goes to the host once (PUT /api/agents/login) and is never read
// back — only a short prefix.
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import type { AgentProviderInfo } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { Button, Input } from '@/shared/view/ui';
import { api } from '@/utils/api';
import { getActivePane, isEmptyPane } from '@/stores/usePaneStore';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import RuntimeRows from './RuntimeRows';

type LoginMode = 'login' | 'token';
type PermissionMode = 'auto' | 'bypassPermissions';
type Renderer = 'default' | 'fullscreen';
type Account = { loggedIn: boolean; authMethod: string | null; subscriptionType: string | null; email: string | null };
type LoginStatus = {
  mode: LoginMode;
  permissionMode: PermissionMode;
  renderer: Renderer;
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

// Sign in: the host opens a session that starts with Claude Code's /login —
// in the active pane's project, else the Getting started project — and the
// settings close so the user lands in it.
async function openSignInSession(): Promise<boolean> {
  const active = getActivePane();
  const projectId = active && !isEmptyPane(active) ? active.projectId : null;
  const response = await fetch('/api/agents/login/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  return response.ok;
}

export default function ClaudeSettings({ claude, onCloseSettings }: { claude: AgentProviderInfo; onCloseSettings?: () => void }) {
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
  const setRenderer = (renderer: Renderer) => run(() => api.setRenderer(renderer));
  const pinnedInput = status?.renderer === 'fullscreen';

  const tokenMode = status?.mode === 'token';
  const showTokenForm = editing || status?.token.set === false;
  // A token in use keeps the advanced part open — it decides how sessions sign in.
  const showAdvanced = advancedOpen || tokenMode;

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
            <SettingsRow
              label="Sign in to Claude"
              description={claude.version ? "Opens a terminal that runs Claude Code's own sign-in (/login)." : 'Claude Code is not set up yet — see Version below.'}
            >
              <Button
                size="sm"
                disabled={busy || !claude.version}
                onClick={() => {
                  void openSignInSession()
                    .then((ok) => { if (ok) onCloseSettings?.(); else setError('Could not open the sign-in session.'); })
                    .catch(() => setError('The cockpit host is not reachable.'));
                }}
              >
                Sign in
              </Button>
            </SettingsRow>
          )}
          {error && !showAdvanced && <p className="px-4 pb-4 text-sm text-destructive">{error}</p>}
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
            <SettingsToggle
              checked={!bypass}
              onChange={(checked: boolean) => void setPermissionMode(checked ? 'auto' : 'bypassPermissions')}
              ariaLabel="Ask before risky actions"
              disabled={busy || status === null}
            />
          </SettingsRow>
          <div className="px-4 py-3 text-sm text-muted-foreground">
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

      <SettingsSection
        title="Display"
        description="How Claude Code draws a session in its pane. Applies to sessions started from now on."
      >
        <SettingsCard divided>
          <SettingsRow
            label="Keep the input at the bottom"
            description={
              pinnedInput
                ? 'On — Claude Code draws the whole pane itself: the input stays in place and the mouse wheel scrolls the conversation above it.'
                : 'Off — the input is the last line of the terminal output and scrolls away with it.'
            }
          >
            <SettingsToggle
              checked={pinnedInput}
              onChange={(checked: boolean) => void setRenderer(checked ? 'fullscreen' : 'default')}
              ariaLabel="Keep the input at the bottom"
              disabled={busy || status === null}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          disabled={tokenMode}
          aria-expanded={showAdvanced}
          className="flex items-center gap-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase hover:text-foreground disabled:hover:text-muted-foreground"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', showAdvanced && 'rotate-90')} />
          Advanced: setup-token
        </button>
        {showAdvanced && (
          <>
            <p className="text-sm text-muted-foreground">
              A long-lived token from <code className="font-mono text-xs text-foreground">claude setup-token</code> for
              runtimes without a browser (servers, tests). Also billed to your subscription, but Claude Code then shows
              “Claude API” and its default model.
            </p>
            <SettingsCard divided>
              <SettingsRow
                label="Use the token for sessions"
                description={tokenMode ? 'On — new sessions use the setup-token instead of the login.' : 'Off — new sessions use the Claude Code login.'}
              >
                <SettingsToggle
                  checked={tokenMode}
                  onChange={(checked: boolean) => void setMode(checked ? 'token' : 'login')}
                  ariaLabel="Use the setup-token for sessions"
                  disabled={busy || (!tokenMode && !status?.token.set)}
                />
              </SettingsRow>

              <SettingsRow
                label="Token"
                description={status?.token.set ? 'Stored in the cockpit home (owner-only), never shown again.' : 'None stored.'}
              >
                {status?.token.set ? (
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-foreground">{status.token.prefix}</span>
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
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">none</span>
                )}
              </SettingsRow>

              {showTokenForm && (
                <div className="space-y-3 px-4 py-4">
                  <p className="text-sm text-muted-foreground">
                    Run <code className="font-mono text-xs text-foreground">claude setup-token</code> in a terminal, sign in,
                    and paste the token it prints (it starts with <code className="font-mono text-xs text-foreground">sk-ant-oat</code>).
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
                      className="flex-1 font-mono text-xs"
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
              {error && <p className="px-4 pb-4 text-sm text-destructive">{error}</p>}
            </SettingsCard>
          </>
        )}
      </div>
    </div>
  );
}
