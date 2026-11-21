// Settings › EML Plugins (plan cockpit-plugins-mcp-channels-plan, mockup v3):
// every plugin — the cockpit's views, services such as Gmail, the user's
// custom MCP servers — switched on or off per space, all or nothing, with one
// of the user's sign-ins where it needs one; and the claude.ai connectors,
// which load around the plugins, switched per space by name.
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import {
  useConnections,
  useOutsideServers,
  usePluginList,
  useSetOutside,
  type ConnectionView,
  type PluginView,
} from '@/lib/plugins-admin';
import { cn } from '@/lib/utils';
import { Chip, FOCUS, LABEL, Switch } from '@/shared/view/ui';
import { useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';

import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';
import SettingsSegmented from '../SettingsSegmented';
import AddCustomMcp from './plugins/AddCustomMcp';
import PluginDetail from './plugins/PluginDetail';
import SpaceCell from './plugins/SpaceCell';
import { PartChips, PluginIcon, TierChip } from './plugins/shared';

type View = 'installed' | 'spaces' | 'connectors' | 'add';

export default function PluginsTab() {
  const [view, setView] = useState<View>('installed');
  const [open, setOpen] = useState<string | null>(null);
  const plugins = usePluginList();
  const spaces = useSpaces();
  const connections = useConnections();

  const opened = open ? plugins.data?.find((p) => p.id === open) : undefined;
  if (opened) return <PluginDetail plugin={opened} spaces={spaces} connections={connections.data ?? []} connectionsLocked={connections.isError} onBack={() => setOpen(null)} />;

  return (
    <div className="space-y-6">
      <SettingsSegmented<View>
        value={view}
        onChange={setView}
        ariaLabel="Plugins view"
        options={[
          { value: 'installed', label: 'Installed' },
          { value: 'spaces', label: 'Spaces' },
          { value: 'connectors', label: 'Connectors' },
          { value: 'add', label: 'Add plugin' },
        ]}
      />
      {plugins.isError && <p className="text-body text-stopped-ink">{plugins.error.message}</p>}
      {view === 'installed' && plugins.data && (
        <Installed plugins={plugins.data} spaces={spaces} connections={connections.data ?? []} onOpen={setOpen} />
      )}
      {view === 'spaces' && plugins.data && <SpacesMatrix plugins={plugins.data} spaces={spaces} connections={connections.data ?? []} onOpen={setOpen} />}
      {view === 'connectors' && <Connectors spaces={spaces} />}
      {view === 'add' && <AddCustomMcp spaces={spaces} onAdded={(id) => { setView('installed'); setOpen(id); }} />}
    </div>
  );
}

function Installed({ plugins, spaces, connections, onOpen }: { plugins: PluginView[]; spaces: SpaceInfo[]; connections: ConnectionView[]; onOpen: (id: string) => void }) {
  return (
    <SettingsSection
      title="Plugins"
      description="Each space starts its sessions with exactly the plugins switched on for it. Open one for its parts, sign-ins and spaces."
    >
      <SettingsCard divided>
        {plugins.map((plugin) => {
          const own = connections.filter((c) => c.plugin === plugin.id);
          return (
            <button
              key={plugin.id}
              type="button"
              onClick={() => onOpen(plugin.id)}
              className={cn('flex min-h-(--target-min) w-full items-center gap-3 px-4 py-3 text-left first:rounded-t-xl last:rounded-b-xl hover:bg-muted', FOCUS)}
            >
              <PluginIcon plugin={plugin} />
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium text-foreground">{plugin.name}</span>
                <span className="mt-1 flex flex-wrap gap-1"><TierChip tier={plugin.tier} /><PartChips plugin={plugin} /></span>
              </span>
              <span className="hidden min-w-0 flex-1 text-ui text-muted-foreground md:block">
                {plugin.auth || plugin.mcp?.settings.some((s) => s.secret)
                  ? (own.length ? own.map((c) => c.label).join(', ') : 'No sign-in yet')
                  : 'No sign-in needed'}
              </span>
              <span className="hidden flex-wrap justify-end gap-1 lg:flex">
                {spaces.map((space) => (
                  <Chip key={space.id} className={cn('py-0.5', space.id in plugin.spaces && 'bg-foreground text-background')}>
                    {space.name}
                  </Chip>
                ))}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          );
        })}
      </SettingsCard>
      <p className="text-body text-muted-foreground">Sending always goes through the channel bridge's outbox; a plugin's tools for jobs only read and look up.</p>
    </SettingsSection>
  );
}

function SpacesMatrix({ plugins, spaces, connections, onOpen }: { plugins: PluginView[]; spaces: SpaceInfo[]; connections: ConnectionView[]; onOpen: (id: string) => void }) {
  return (
    <SettingsSection
      title="Plugins per space"
      description="A plugin is all or nothing per space: switched on, a space gets every part that is on for the plugin. The cockpit writes each space's MCP config, its channel accounts and its pane views from this table; a running session keeps what it started with."
    >
      <SettingsCard className="overflow-x-auto">
        <table className="w-full min-w-max text-body">
          <thead>
            <tr className={cn('text-left', LABEL)}>
              <th className="px-4 py-2 font-semibold">Plugin</th>
              {spaces.map((space) => (
                <th key={space.id} className="px-4 py-2 font-semibold">
                  {space.name}
                  <span className="block font-normal tracking-normal normal-case">{space.agentName ?? space.agent ?? 'no agent'}{space.shared ? ' · shared' : ''}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {plugins.map((plugin) => (
              <tr key={plugin.id}>
                <th scope="row" className="px-4 py-3 text-left font-medium">
                  <button type="button" onClick={() => onOpen(plugin.id)} className={cn('inline-flex min-h-(--target-min) items-center text-left hover:underline', FOCUS)}>{plugin.name}</button>
                  <span className="mt-1 flex gap-1"><PartChips plugin={plugin} /></span>
                </th>
                {spaces.map((space) => (
                  <td key={space.id} className="px-4 py-3"><SpaceCell plugin={plugin} space={space} connections={connections} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsCard>
      {spaces.some((s) => s.shared) && <p className="text-body text-muted-foreground">A channel takes no messages in a shared space yet: the bridge routes only to the jobs of your own spaces.</p>}
    </SettingsSection>
  );
}

function Connectors({ spaces }: { spaces: SpaceInfo[] }) {
  const servers = useOutsideServers();
  const setOutside = useSetOutside();
  // A space whose agent has a runtime of its own gets no connectors at all (strict MCP config).
  const open = spaces.filter((s) => !s.ownRuntime);
  return (
    <SettingsSection
      title="claude.ai connectors"
      description="Your claude.ai connectors and Claude Code's own plugin servers load in every space that shares the cockpit's Claude login, unless switched off here. A space whose agent has a runtime of its own never gets them."
    >
      {servers.isPending && <p className="text-body text-muted-foreground">Asking Claude Code for your connectors…</p>}
      {servers.isError && <p className="text-body text-stopped-ink">{servers.error.message}</p>}
      {servers.data && servers.data.length === 0 && <p className="text-body text-muted-foreground">Claude Code names no connectors for the cockpit's login.</p>}
      {servers.data && servers.data.length > 0 && (
        <SettingsCard className="overflow-x-auto">
          <table className="w-full min-w-max text-body">
            <thead>
              <tr className={cn('text-left', LABEL)}>
                <th className="px-4 py-2 font-semibold">Connector</th>
                {open.map((space) => <th key={space.id} className="px-4 py-2 font-semibold">{space.name}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {servers.data.map((server) => (
                <tr key={server.name}>
                  <th scope="row" className="px-4 py-3 text-left font-medium">
                    {server.name.replace(/^claude\.ai /, '')}
                    <span className="block text-ui font-normal text-muted-foreground">{server.kind === 'connector' ? 'claude.ai connector' : 'Claude Code plugin'}</span>
                  </th>
                  {open.map((space) => (
                    <td key={space.id} className="px-4 py-3">
                      <Switch
                        checked={!server.off.includes(space.id)}
                        disabled={setOutside.isPending}
                        onChange={(enabled) => setOutside.mutate({ space: space.id, server: server.name, enabled })}
                        ariaLabel={`${server.name} in ${space.name}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </SettingsCard>
      )}
      {setOutside.isError && <p className="text-body text-stopped-ink">{setOutside.error.message}</p>}
    </SettingsSection>
  );
}
