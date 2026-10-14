// Settings › Account: who you are in this brain (from GET /api/brain-info) and
// your plan. Today everyone runs the free open-source build from GitHub; Pro
// and Team are announced, nothing more. Changing the name comes later — the
// name is also in the identity engrams of every space's brain.
import { mainUser, useBrainInfo } from '../../hooks/useBrainInfo';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

export default function AccountTab() {
  const { info, failed } = useBrainInfo();
  const fallback = failed ? 'unavailable' : '…';
  const user = mainUser(info);

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

      <SettingsSection title="Plan">
        <SettingsCard divided>
          <SettingsRow label="Free" description="Open source, from GitHub.">
            <Pill active>current</Pill>
          </SettingsRow>
          <SettingsRow label="Pro">
            <Pill>coming soon</Pill>
          </SettingsRow>
          <SettingsRow label="Team">
            <Pill>coming soon</Pill>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
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
