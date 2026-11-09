// Settings › Data: where this cockpit keeps its files, and import & export to come.
import { useAboutInfo } from '@/hooks/useAboutInfo';

import type { SettingsMainTabMeta } from '../../constants/constants';
import { useBrainInfo } from '../../hooks/useBrainInfo';
import SettingsCard from '../SettingsCard';
import SettingsPlaceholder from '../SettingsPlaceholder';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

export default function DataTab({ tab }: { tab: SettingsMainTabMeta }) {
  const { info, failed } = useBrainInfo();
  const { info: about } = useAboutInfo();
  const fallback = failed ? 'unavailable' : '…';

  return (
    <div className="space-y-8">
      <SettingsSection title="Cockpit">
        <SettingsCard divided>
          <SettingsRow label="Cockpit home" description="All state of this cockpit instance lives here">
            <Path>{info?.home ?? fallback}</Path>
          </SettingsRow>
          <SettingsRow
            label="Claude config directory"
            description="The app's own Claude environment — your local ~/.claude stays untouched"
          >
            <Path>{about?.configDir ?? '—'}</Path>
          </SettingsRow>
          <SettingsRow label="Backups folder">
            <Path>{info ? `${info.home}/backups` : fallback}</Path>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsPlaceholder tab={tab} />
    </div>
  );
}

function Path({ children }: { children: React.ReactNode }) {
  return <span className="block max-w-sm break-all text-right font-mono text-xs text-foreground">{children}</span>;
}
