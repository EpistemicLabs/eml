// Cockpit addition: a tab whose substrate doesn't exist yet shows its
// heading and the one-liner from constants — the structure is visible,
// nothing pretends to work.
import SettingsCard from './SettingsCard';
import SettingsSection from './SettingsSection';
import type { SettingsMainTabMeta } from '../constants/constants';

export default function SettingsPlaceholder({ tab }: { tab: SettingsMainTabMeta }) {
  const Icon = tab.icon;
  return (
    <SettingsSection title={tab.label}>
      <SettingsCard>
        <div className="flex items-start gap-3 px-4 py-4">
          <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">Coming up</div>
            <p className="mt-0.5 text-sm text-muted-foreground">{tab.blurb}</p>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
