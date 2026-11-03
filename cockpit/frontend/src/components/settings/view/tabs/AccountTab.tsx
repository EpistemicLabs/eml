// Settings › Account: who you are in this brain (from GET /api/brain-info),
// your EML account (sign-in by email and a mailed code, the team-brain beta,
// the team brains the account created) and your plan. Everyone runs the free
// open-source build from GitHub; Team is in a closed beta, Pro is announced.
// Changing the name comes later — the name is also in the identity engrams of
// every space's brain.
import { useState } from 'react';

import { useAccount, type AccountStatus } from '../../hooks/useAccount';
import { mainUser, useBrainInfo } from '../../hooks/useBrainInfo';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

const button = 'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-foreground/5 disabled:opacity-50';
const input = 'rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-foreground/40';

export default function AccountTab() {
  const { info, failed } = useBrainInfo();
  const fallback = failed ? 'unavailable' : '…';
  const user = mainUser(info);
  const account = useAccount();
  const beta = account.status?.signedIn === true && account.status.beta;

  return (
    <div className="space-y-8">
      <SettingsSection title="You">
        <SettingsCard divided>
          <SettingsRow label="Name" description="How your agent knows you">
            <span className="text-sm text-foreground">{info ? user?.name ?? '—' : fallback}</span>
          </SettingsRow>
          <SettingsRow label="Writes as" description="The handle stamped on every engram your sessions write">
            <Mono>{info ? info.author ?? '—' : fallback}</Mono>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="EML account"
        description="Shared team brains need an EML account. Sign in with your email; the code arrives by mail."
      >
        <AccountCard account={account} />
      </SettingsSection>

      {account.status?.signedIn && account.status.brains && (
        <SettingsSection title="Team brains" description="The shared brains this account created, with their current members.">
          <BrainsCard brains={account.status.brains} />
        </SettingsSection>
      )}

      <SettingsSection title="Plan">
        <SettingsCard divided>
          <SettingsRow label="Free" description="Open source, from GitHub.">
            <Pill active>current</Pill>
          </SettingsRow>
          <SettingsRow label="Pro">
            <Pill>coming soon</Pill>
          </SettingsRow>
          <SettingsRow label="Team" description={beta ? 'Your account is in the closed beta.' : undefined}>
            {beta ? <Pill active>beta</Pill> : <Pill>coming soon</Pill>}
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

/** Sign-in by email and code, or the signed-in account with sign-out. */
function AccountCard({ account }: { account: ReturnType<typeof useAccount> }) {
  const { status, failed, step, busy, error, sendCode, signIn, signOut, restart } = account;
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');

  if (failed) {
    return (
      <SettingsCard>
        <div className="px-4 py-4 text-sm text-muted-foreground">The cockpit could not read the account state.</div>
      </SettingsCard>
    );
  }
  if (!status) {
    return (
      <SettingsCard>
        <div className="px-4 py-4 text-sm text-muted-foreground">…</div>
      </SettingsCard>
    );
  }

  if (status.signedIn) {
    return (
      <SettingsCard divided>
        <SettingsRow
          label={`Signed in as ${status.email}`}
          description={signedInDescription(status)}
        >
          <button type="button" className={button} disabled={busy} onClick={() => void signOut()}>
            Sign out
          </button>
        </SettingsRow>
        {error && <Problem>{error}</Problem>}
      </SettingsCard>
    );
  }

  return (
    <SettingsCard divided>
      {step === 'email' ? (
        <SettingsRow label="Sign in" description="Enter the email of your EML account. We mail you a code.">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void sendCode(email);
            }}
          >
            <input
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`w-52 ${input}`}
            />
            <button type="submit" className={button} disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        </SettingsRow>
      ) : (
        <SettingsRow label="Enter the code" description={`We sent a 6-digit code to ${email.trim()} if an account exists for it. It is valid for 24 hours.`}>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void signIn(code).then(() => setCode(''));
            }}
          >
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={`w-28 font-mono ${input}`}
            />
            <button type="submit" className={button} disabled={busy || code.replace(/\s/g, '').length !== 6}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button type="button" className={button} disabled={busy} onClick={restart}>
              Use another email
            </button>
          </form>
        </SettingsRow>
      )}
      {error && <Problem>{error}</Problem>}
    </SettingsCard>
  );
}

function signedInDescription(status: Extract<AccountStatus, { signedIn: true }>): string {
  if (status.service === 'unavailable') return 'The account service cannot be reached right now. You stay signed in.';
  return status.beta ? 'In the team-brain beta.' : 'Not in the team-brain beta yet.';
}

function BrainsCard({ brains }: { brains: Array<{ brain: string; created_at: string; members: number }> }) {
  if (brains.length === 0) {
    return (
      <SettingsCard>
        <div className="px-4 py-4 text-sm text-muted-foreground">No shared brain yet.</div>
      </SettingsCard>
    );
  }
  return (
    <SettingsCard divided>
      {brains.map((b) => (
        <SettingsRow key={b.brain} label={b.brain} description={`Created ${formatDate(b.created_at)}`}>
          <span className="text-sm text-foreground">{b.members} {b.members === 1 ? 'member' : 'members'}</span>
        </SettingsRow>
      ))}
    </SettingsCard>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function Problem({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-3 text-xs text-destructive">{children}</div>;
}

function Pill({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
        active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
      }`}
    >
      {children}
    </span>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="block font-mono text-xs text-foreground">{children}</span>;
}
