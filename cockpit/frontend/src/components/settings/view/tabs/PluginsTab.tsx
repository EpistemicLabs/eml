// Settings › EML Plugins:
// every plugin — the cockpit's views, services such as Gmail, the user's
// custom MCP servers — switched on or off per space, all or nothing, with one
// of the user's sign-ins where it needs one. Three tabs: Installed, Spaces (the
// plugins and, below them, the claude.ai connectors per space) and Add plugin;
// a plugin opens on its own page.
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import {
  useConnections,
  useDismissImportNotice,
  useOutsideServers,
  usePluginList,
  useSetOutside,
  type ConnectionView,
  type PluginView,
} from '@/lib/plugins-admin';
import { cn } from '@/lib/utils';
import { Button, Chip, FOCUS, HUE, LABEL, Switch, TAB, TRACK } from '@/shared/view/ui';
import { useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';

import type { SettingsMainTabMeta } from '../../constants/constants';
import SettingsHeading from '../SettingsHeading';
import AddCustomMcp from './AddCustomMcp';
import PluginDetail from './PluginDetail';
import SpaceCell from './PluginSpaceCell';
import { PartChips, PluginIcon, TierChip, needsSignIn } from './PluginShared';

type View = 'installed' | 'spaces' | 'add';

const TABS: Array<[View, string]> = [['installed', 'Installed'], ['spaces', 'Spaces'], ['add', 'Add plugin']];

export default function PluginsTab({ tab }: { tab: SettingsMainTabMeta }) {
  const [view, setView] = useState<View>('installed');
  const [open, setOpen] = useState<string | null>(null);
  const [onlyImported, setOnlyImported] = useState(false);
  const list = usePluginList();
  const spaces = useSpaces();
  const connections = useConnections();
  const plugins = list.data?.plugins ?? [];

  const opened = open ? plugins.find((p) => p.id === open) : undefined;
  if (opened) return <PluginDetail plugin={opened} spaces={spaces} connections={connections.data ?? []} onBack={() => setOpen(null)} />;

  return (
    <div className="space-y-4">
      <SettingsHeading tab={tab}>
        <div role="tablist" aria-label="Plugins" className={cn(TRACK, 'ml-auto bg-muted')}>
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => { setView(id); setOnlyImported(false); }}
              className={TAB}
            >
              {label}
            </button>
          ))}
        </div>
      </SettingsHeading>
      {list.isError && <p className="text-body text-stopped-ink">{list.error.message}</p>}
      {view !== 'add' && list.data?.importNotice && (
        <ImportNotice count={list.data.importNotice.count} onReview={() => { setView('installed'); setOnlyImported(true); }} />
      )}
      {view === 'installed' && list.data && (
        <Installed
          plugins={onlyImported ? plugins.filter((p) => p.imported) : plugins}
          filtered={onlyImported}
          onShowAll={() => setOnlyImported(false)}
          spaces={spaces}
          connections={connections.data ?? []}
          onOpen={setOpen}
        />
      )}
      {view === 'spaces' && list.data && <SpacesTable plugins={plugins} spaces={spaces} connections={connections.data ?? []} onOpen={setOpen} />}
      {view === 'add' && <AddCustomMcp spaces={spaces} onAdded={(id) => { setView('installed'); setOpen(id); }} />}
    </div>
  );
}

/** Amber: it needs the user once — the servers from the Claude config became plugins. */
function ImportNotice({ count, onReview }: { count: number; onReview: () => void }) {
  const dismiss = useDismissImportNotice();
  return (
    <div role="status" className={cn('flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-body', HUE.you.edge, HUE.you.tint)}>
      <span className="min-w-0 flex-1 text-foreground">
        <b className={HUE.you.ink}>{count} MCP server{count === 1 ? ' from your Claude config was' : 's from your Claude config were'} imported</b>
        {' '}as custom MCP plugins; their space assignments were kept.
      </span>
      <span className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onReview}>Review imported</Button>
        <Button size="sm" variant="outline" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>Done</Button>
      </span>
    </div>
  );
}

function Installed({ plugins, filtered, onShowAll, spaces, connections, onOpen }: {
  plugins: PluginView[];
  filtered: boolean;
  onShowAll: () => void;
  spaces: SpaceInfo[];
  connections: ConnectionView[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      {filtered && (
        <p className="text-body text-muted-foreground">
          Showing the imported custom MCP plugins ({plugins.length}).{' '}
          <button type="button" onClick={onShowAll} className={cn('text-foreground underline underline-offset-2', FOCUS)}>Show all</button>
        </p>
      )}
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {plugins.map((plugin) => {
          const own = connections.filter((c) => c.plugin === plugin.id);
          return (
            <button
              key={plugin.id}
              type="button"
              onClick={() => onOpen(plugin.id)}
              className={cn('grid w-full grid-cols-(--grid-plugin-row) items-center gap-3 px-4 py-3 text-left hover:bg-muted', FOCUS)}
            >
              <PluginIcon plugin={plugin} />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-body font-semibold text-foreground">{plugin.name}</span>
                <span className="flex flex-wrap gap-1"><TierChip tier={plugin.tier} /><PartChips plugin={plugin} /></span>
              </span>
              <span className="min-w-0 text-ui text-muted-foreground">
                {!needsSignIn(plugin) && 'No sign-in needed'}
                {needsSignIn(plugin) && own.length === 0 && <span className={HUE.you.ink}>No sign-in yet</span>}
                {needsSignIn(plugin) && own.map((c) => (
                  <span key={c.id} className="flex items-center gap-1.5">
                    <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', c.signInNeeded ? 'bg-status-stopped' : 'bg-foreground')} />
                    {c.label}
                    {c.signInNeeded && <span className="text-stopped-ink">· sign in again</span>}
                  </span>
                ))}
              </span>
              <span className="flex min-w-0 flex-wrap gap-1">
                {spaces.map((space) => (
                  <Chip key={space.id} className={cn('rounded-md py-0.5', space.id in plugin.spaces ? 'bg-foreground text-background' : 'border border-border bg-transparent')}>
                    {space.name}
                  </Chip>
                ))}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <p className="text-ui text-muted-foreground">
        Each space starts its sessions with exactly the plugins switched on for it. Sending always goes through the channel bridge; a plugin's tools for jobs only read and look up.
      </p>
    </div>
  );
}

/** The plugins per space, and under them the claude.ai connectors: one table, one row each. */
function SpacesTable({ plugins, spaces, connections, onOpen }: { plugins: PluginView[]; spaces: SpaceInfo[]; connections: ConnectionView[]; onOpen: (id: string) => void }) {
  const servers = useOutsideServers();
  const setOutside = useSetOutside();
  const cell = 'px-3 py-2.5 align-middle';
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-max text-body">
          <thead className="bg-muted">
            <tr className={cn('text-left', LABEL)}>
              <th className={cell}>Plugin</th>
              {spaces.map((space) => (
                <th key={space.id} className={cell}>
                  {space.name}
                  <span className="block font-normal tracking-normal normal-case">agent: {space.agentName ?? space.agent ?? 'none'}{space.shared ? ' · shared' : ''}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {plugins.map((plugin) => (
              <tr key={plugin.id}>
                <th scope="row" className={cn(cell, 'text-left font-semibold')}>
                  <button type="button" onClick={() => onOpen(plugin.id)} className={cn('inline-flex min-h-(--target-min) items-center text-left hover:underline', FOCUS)}>{plugin.name}</button>
                  <span className="mt-1 flex gap-1"><PartChips plugin={plugin} /></span>
                </th>
                {spaces.map((space) => (
                  <td key={space.id} className={cell}><SpaceCell plugin={plugin} space={space} connections={connections} /></td>
                ))}
              </tr>
            ))}
            <tr className="bg-muted">
              <th scope="colgroup" colSpan={spaces.length + 1} className={cn(cell, 'text-left', LABEL)}>
                claude.ai connectors
                {servers.isPending && <span className="ml-2 font-normal tracking-normal normal-case">asking Claude Code…</span>}
              </th>
            </tr>
            {servers.data?.map((server) => (
              <tr key={server.name}>
                <th scope="row" className={cn(cell, 'text-left font-semibold')}>
                  {server.name.replace(/^claude\.ai /, '')}
                  <span className="block text-ui font-normal text-muted-foreground">{server.kind === 'connector' ? 'claude.ai connector' : 'Claude Code plugin'}</span>
                  {server.signIn === 'needs-sign-in' && (
                    <span className={cn('block text-ui font-normal', HUE.you.ink)}>
                      Not signed in: its tools fail in every space where it is on. Sign in with /mcp in a session{server.kind === 'connector' ? ' or in claude.ai\'s connector settings' : ''}, or switch it off.
                    </span>
                  )}
                </th>
                {spaces.map((space) => (
                  <td key={space.id} className={cell}>
                    {space.ownRuntime ? (
                      <span className="text-ui text-muted-foreground" title="An agent with its own runtime gets no connectors">–</span>
                    ) : (
                      <Switch
                        checked={!server.off.includes(space.id)}
                        disabled={setOutside.isPending}
                        onChange={(enabled) => setOutside.mutate({ space: space.id, server: server.name, enabled })}
                        ariaLabel={`${server.name} in ${space.name}`}
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {servers.data?.length === 0 && (
              <tr><td colSpan={spaces.length + 1} className={cn(cell, 'text-ui text-muted-foreground')}>Claude Code names no connectors for the cockpit's login.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {(setOutside.isError || servers.isError) && <p className="text-body text-stopped-ink">{(setOutside.error ?? servers.error)?.message}</p>}
      <p className="text-ui text-muted-foreground">
        A plugin is all or nothing per space: switched on, a space gets every part that is on for the plugin. From this table the cockpit writes each space's MCP config, its channel accounts and its visible panes; a running session keeps what it started with. Where you have several sign-ins for a plugin, the space picks one. The connectors load around the plugins in every space that shares the cockpit's Claude login; a space whose agent has its own runtime gets none.
        {spaces.some((s) => s.shared) && ' A channel takes no messages in a shared space yet.'}
      </p>
    </div>
  );
}
