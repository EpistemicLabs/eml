// Settings › Advanced: switches for debugging the cockpit, off by default.
import { Switch } from '@/shared/view/ui';
import { useTerminalFallbackSwitch } from '@/lib/terminal-fallback';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

export default function AdvancedTab() {
  const fallback = useTerminalFallbackSwitch();
  return (
    <div className="space-y-8">
      <SettingsSection title="Debugging">
        <SettingsCard divided>
          <SettingsRow
            label="Terminal fallback"
            description="Opens a session in the agent's own terminal, for debugging."
          >
            <Switch
              checked={fallback.enabled === true}
              onChange={(checked: boolean) => fallback.set(checked)}
              ariaLabel="Terminal fallback"
              disabled={fallback.enabled === undefined || fallback.pending}
            />
          </SettingsRow>
          {(fallback.error || fallback.failed) && (
            <p className="px-4 pb-4 text-body text-stopped-ink">{fallback.error?.message ?? 'The cockpit host did not say whether the terminal fallback is on.'}</p>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
