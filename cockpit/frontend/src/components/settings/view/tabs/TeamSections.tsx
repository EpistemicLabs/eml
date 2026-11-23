// Settings › Spaces for a shared space (spec team-brain-membership-flows-spec
// §5): its state, the members, and, for an owner, the invites: a link made for a
// member or an owner (decision invite-role-set-at-invite), shown once; the
// open invites with their expiry; a join waiting on one, confirmed after the
// fingerprint was compared, or declined. Every action goes through the host
// (lib/team.ts); the store reads again after each. What is technical (relay,
// brain id, your member) goes under the space's technical details.
import { useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button, Chip, Select } from '@/shared/view/ui';
import { cancelInvite, confirmJoin, createInvite, errorText, joinStep, relayHost, stateTitle, type InviteView, type Role, type TeamSnapshot } from '@/lib/team';
import { refreshTeams } from '@/stores/useTeamStore';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import { SETTINGS_INPUT_CLASS } from '../../constants/constants';

const INVITE_NOTE = 'Send this link over a channel you trust. It works once and expires in 7 days; it is not shown again.';
const COMPARE_NOTE = 'Compare the fingerprint with them over another channel before you confirm.';

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

/** The state in one line: Live, or what the space is waiting for. */
export function teamStatus(team: TeamSnapshot): string {
  const state = stateTitle(team) ?? 'Live';
  const note = joinStep(team.state) ?? team.read_only;
  return note ? `${state} — ${note}` : state;
}

/** The team's rows of the technical details. */
export function TeamDetailRows({ team }: { team: TeamSnapshot }) {
  return (
    <>
      <SettingsRow label="Relay"><Mono>{relayHost(team.relay) ?? '—'}</Mono></SettingsRow>
      <SettingsRow label="Brain ID"><Mono>{team.brain}</Mono></SettingsRow>
      <SettingsRow label="Your handle"><Mono>{team.member?.handle ?? '—'}</Mono></SettingsRow>
      <SettingsRow label="Your fingerprint"><Mono>{team.member?.fingerprint ?? '—'}</Mono></SettingsRow>
    </>
  );
}

export default function TeamSections({ spaceId, team }: { spaceId: string; team: TeamSnapshot }) {
  const owner = team.member?.role === 'owner';
  return (
    <>
      <SettingsSection title="Members">
        <SettingsCard divided>
          {team.members.length === 0 ? (
            <div className="px-4 py-4 text-body text-muted-foreground">No members recorded yet.</div>
          ) : (
            team.members.map((m) => (
              <SettingsRow key={m.id} label={m.handle ?? m.fingerprint}>
                <span className="flex items-center gap-2 text-ui text-muted-foreground">
                  {m.self && <Pill>you</Pill>}
                  <span>{m.role}</span>
                  <span>· {m.devices} {m.devices === 1 ? 'device' : 'devices'}</span>
                </span>
              </SettingsRow>
            ))
          )}
        </SettingsCard>
      </SettingsSection>

      {owner && <Invites spaceId={spaceId} invites={team.invites} />}
    </>
  );
}

function Invites({ spaceId, invites }: { spaceId: string; invites: InviteView[] }) {
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async (key: string, action: () => Promise<{ status: number; body: unknown }>, ok: number, onOk?: (body: unknown) => void) => {
    setBusy(key);
    setError(null);
    try {
      const answer = await action();
      if (answer.status !== ok) { setError(errorText(answer.body, `The cockpit answered ${answer.status}.`)); return; }
      onOk?.(answer.body);
      await refreshTeams();
    } catch {
      setError('The cockpit could not be reached.');
    } finally {
      setBusy(null);
    }
  };

  const create = () => run('create', () => createInvite(spaceId, role), 201, (body) => {
    const made = body as { link?: string };
    setLink(typeof made.link === 'string' ? made.link : null);
    setCopied(false);
  });

  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); }
  };

  return (
    <SettingsSection title="Invites">
      <SettingsCard divided>
        <SettingsRow label="Create invite link" description={link ? INVITE_NOTE : 'For a member, or for an owner who can invite too.'}>
          <div className="flex items-center gap-2">
            <Select
              aria-label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              disabled={busy !== null}
              className="min-h-(--target-min) px-2 text-ui"
            >
              <option value="member">member</option>
              <option value="owner">owner</option>
            </Select>
            <Button size="sm" onClick={() => void create()} disabled={busy !== null}>
              {busy === 'create' ? <Loader2 aria-hidden className="animate-spin" /> : 'Create invite link'}
            </Button>
          </div>
        </SettingsRow>
        {link && (
          <div className="flex items-center gap-2 px-4 py-3">
            <input
              readOnly
              value={link}
              aria-label="Invite link"
              onFocus={(e) => e.currentTarget.select()}
              className={cn(SETTINGS_INPUT_CLASS, 'min-w-0 flex-1 font-code')}
            />
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        )}
        {error && <div className="px-4 py-3 text-ui text-stopped-ink">{error}</div>}
        {invites.map((invite) => (
          invite.pending ? (
            <SettingsRow
              key={invite.invite_id}
              label={`${invite.pending.handle} wants to join — fingerprint ${invite.pending.fingerprint}`}
              description={`${COMPARE_NOTE} Joins as ${invite.role}.`}
            >
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={busy !== null} onClick={() => void run(invite.invite_id, () => confirmJoin(spaceId, invite.invite_id), 200)}>
                  {busy === invite.invite_id ? <Loader2 aria-hidden className="animate-spin" /> : 'Confirm'}
                </Button>
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run(invite.invite_id, () => cancelInvite(spaceId, invite.invite_id), 200)}>
                  Decline
                </Button>
              </div>
            </SettingsRow>
          ) : (
            <SettingsRow key={invite.invite_id} label={`Invite for a ${invite.role}`} description={`Expires ${formatDate(invite.expires_at)}`}>
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run(invite.invite_id, () => cancelInvite(spaceId, invite.invite_id), 200)}>
                {busy === invite.invite_id ? <Loader2 aria-hidden className="animate-spin" /> : 'Cancel'}
              </Button>
            </SettingsRow>
          )
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return <Chip hue="mark" className="py-0.5">{children}</Chip>;
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="block font-code text-ui text-foreground">{children}</span>;
}
