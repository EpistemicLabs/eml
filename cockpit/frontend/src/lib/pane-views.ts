// The views a pane can show (decision cockpit-builtin-plugins-first), in two
// groups: the session's views (terminal, chat) and the plugins, the project's
// views. Brain is a fixed plugin; the others are the cockpit's own plugins,
// which Settings › EML Plugins switches on or off (host: /api/plugins). The
// tab bar, the "+" menus and the command palette are built from this list.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, FolderGit2, MessageSquare, NotebookPen, Terminal, type LucideIcon } from 'lucide-react';

import type { PaneView } from '@/stores/usePaneStore';

/** A plugin the user can switch off; the host knows the same ids. */
export type PluginId = 'note' | 'worktrees';

export interface PaneViewDef {
  view: PaneView;
  label: string;
  icon: LucideIcon;
  group: 'session' | 'plugin';
  /** Set on a plugin the user can switch off. */
  plugin?: PluginId;
  /** The "+" menu's entry for a pane opened in this view. */
  newLabel: string;
  /** Settings › EML Plugins: what the plugin shows. */
  description?: string;
}

export const PANE_VIEW_DEFS: ReadonlyArray<PaneViewDef> = [
  { view: 'terminal', label: 'Terminal', icon: Terminal, group: 'session', newLabel: 'New session' },
  { view: 'chat', label: 'Chat', icon: MessageSquare, group: 'session', newLabel: 'New chat session' },
  { view: 'brain', label: 'Brain', icon: Brain, group: 'plugin', newLabel: 'New brain view' },
  {
    view: 'note', label: 'Note', icon: NotebookPen, group: 'plugin', plugin: 'note', newLabel: 'New note',
    description: 'Notes of a project, kept as engrams in its brain; the sidebar lists them under each project.',
  },
  {
    view: 'worktrees', label: 'Worktrees', icon: FolderGit2, group: 'plugin', plugin: 'worktrees', newLabel: 'New worktrees view',
    description: "The project's git worktrees and branches, the sessions working in them and the local ports in use.",
  },
];

export const paneViewDef = (view: PaneView): PaneViewDef =>
  PANE_VIEW_DEFS.find((def) => def.view === view) ?? PANE_VIEW_DEFS[0];

export const PLUGIN_DEFS = PANE_VIEW_DEFS.filter((def): def is PaneViewDef & { plugin: PluginId } => !!def.plugin);

// ── Which plugins are on (host: /api/plugins, the same for every browser) ──

const pluginsKey = ['cockpit-plugins'] as const;

type PluginStates = Record<PluginId, boolean>;

async function requestPlugins(init?: RequestInit): Promise<PluginStates> {
  const res = await fetch('/api/plugins', init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  return Object.fromEntries(
    ((body?.plugins ?? []) as Array<{ id: PluginId; enabled: boolean }>).map((p) => [p.id, p.enabled]),
  ) as PluginStates;
}

export function usePluginStates() {
  return useQuery({ queryKey: pluginsKey, queryFn: () => requestPlugins(), staleTime: 60_000 });
}

/**
 * Whether a view can be shown: the session views and Brain always, a plugin
 * while it is on. Until the host has answered every plugin counts as on, so a
 * pane showing one does not flip to Brain while the page loads.
 */
export function useViewEnabled(): (view: PaneView) => boolean {
  const states = usePluginStates().data;
  return (view) => {
    const plugin = paneViewDef(view).plugin;
    return !plugin || !states || states[plugin] !== false;
  };
}

export function useSetPluginEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: PluginId; enabled: boolean }) =>
      requestPlugins({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, enabled }) }),
    onSuccess: (states) => qc.setQueryData(pluginsKey, states),
  });
}
