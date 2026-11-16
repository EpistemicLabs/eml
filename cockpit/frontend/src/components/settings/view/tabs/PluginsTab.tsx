// Settings › EML Plugins: the cockpit's own plugins (decision
// cockpit-builtin-plugins-first) — project views next to the brain, switched
// on or off for the whole cockpit. Brain is listed as fixed.
import { PLUGIN_DEFS, paneViewDef, usePluginStates, useSetPluginEnabled } from '@/lib/pane-views';

import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

export default function PluginsTab() {
  const states = usePluginStates();
  const setEnabled = useSetPluginEnabled();
  const brain = paneViewDef('brain');

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Cockpit plugins"
        description="Views a pane can show next to its sessions. A plugin switched off leaves the tab bar and the + menus; what it holds stays — notes stay in the brain."
      >
        <SettingsCard divided>
          <SettingsRow label={<Label icon={brain.icon} text={brain.label} />} description="The project's brain: timeline, graph, tasks. Always on.">
            <SettingsToggle checked disabled onChange={() => {}} ariaLabel="Brain is always on" />
          </SettingsRow>
          {PLUGIN_DEFS.map((def) => (
            <SettingsRow key={def.plugin} label={<Label icon={def.icon} text={def.label} />} description={def.description}>
              <SettingsToggle
                checked={states.data?.[def.plugin] ?? true}
                disabled={!states.data || setEnabled.isPending}
                onChange={(enabled) => setEnabled.mutate({ id: def.plugin, enabled })}
                ariaLabel={`${def.label} plugin`}
              />
            </SettingsRow>
          ))}
        </SettingsCard>
        {setEnabled.isError && <p className="text-sm text-destructive">{setEnabled.error.message}</p>}
      </SettingsSection>
    </div>
  );
}

function Label({ icon: Icon, text }: { icon: React.ComponentType<{ className?: string }>; text: string }) {
  return (
    <span className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      {text}
    </span>
  );
}
