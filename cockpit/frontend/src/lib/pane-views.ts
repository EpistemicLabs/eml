// The views a pane can show (decision cockpit-builtin-plugins-first), in two
// groups: the session's (its chat; the terminal is only a hidden fallback,
// lib/terminal-fallback.ts) and the plugins, the project's
// views, which Settings › EML Plugins switches on or off (host: /api/plugins). The
// tab bar, the "+" menus and the command palette are built from this list.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, Clock, FileDiff, FolderGit2, MessageSquare, NotebookPen, SquareTerminal, type LucideIcon } from 'lucide-react';

import type { PaneView } from '@/stores/usePaneStore';
import { useActiveSpace } from '@/stores/useSpaceStore';

/** A plugin the user can switch off; the host knows the same ids. */
export type PluginId = 'brain' | 'note' | 'worktrees' | 'repository' | 'shell' | 'time';

export interface PaneViewDef {
  view: PaneView;
  label: string;
  icon: LucideIcon;
  group: 'session' | 'plugin';
  /** Set on a plugin, which the user can switch off. */
  plugin?: PluginId;
  /** The "+" menu's entry for a pane opened in this view. */
  newLabel: string;
  /** Settings › EML Plugins: what the plugin shows. */
  description?: string;
}

export const PANE_VIEW_DEFS: ReadonlyArray<PaneViewDef> = [
  { view: 'chat', label: 'Chat', icon: MessageSquare, group: 'session', newLabel: 'New session' },
  {
    view: 'brain', label: 'Brain', icon: Brain, group: 'plugin', plugin: 'brain', newLabel: 'New brain view',
    description: "The project's brain: timeline, graph, tasks. Off hides only this view; the header's Brain tab stays.",
  },
  {
    view: 'note', label: 'Note', icon: NotebookPen, group: 'plugin', plugin: 'note', newLabel: 'New note',
    description: 'Notes of a project, kept as engrams in its brain; the sidebar lists them under each project.',
  },
  {
    view: 'worktrees', label: 'Worktrees', icon: FolderGit2, group: 'plugin', plugin: 'worktrees', newLabel: 'New worktrees view',
    description: "The project's git worktrees and branches, the sessions working in them and the local ports in use.",
  },
  {
    view: 'repository', label: 'Repository', icon: FileDiff, group: 'plugin', plugin: 'repository', newLabel: 'New repository view',
    description: "What changed in a checkout of the project — uncommitted, on its branch, per commit — and all its files, read-only.",
  },
  {
    view: 'shell', label: 'Shell', icon: SquareTerminal, group: 'plugin', plugin: 'shell', newLabel: 'New shell',
    description: 'A terminal on this computer: your own shell in your home folder, as in the Terminal app. Remote users only get it after `eml-cockpit remote shell on`.',
  },
  {
    view: 'time', label: 'Time', icon: Clock, group: 'plugin', plugin: 'time', newLabel: 'New time view',
    description: 'Your time at the cockpit per project, counted on its own (5 minutes without input pause it), and the time your agents ran, per session and task.',
  },
];

export const paneViewDef = (view: PaneView): PaneViewDef =>
  PANE_VIEW_DEFS.find((def) => def.view === view) ?? PANE_VIEW_DEFS[0];

export const PLUGIN_DEFS = PANE_VIEW_DEFS.filter((def): def is PaneViewDef & { plugin: PluginId } => !!def.plugin);

// ── Which plugins are on in the active space (host: /api/plugins?space=, the same for every browser) ──

const pluginsKey = ['cockpit-plugins'] as const;

type PluginStates = Record<PluginId, boolean>;

async function requestPlugins(space: string | null, init?: RequestInit): Promise<PluginStates> {
  const res = await fetch(space ? `/api/plugins?space=${encodeURIComponent(space)}` : '/api/plugins', init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  return Object.fromEntries(
    ((body?.plugins ?? []) as Array<{ id: PluginId; enabled: boolean }>).map((p) => [p.id, p.enabled]),
  ) as PluginStates;
}

/** The plugins switched on in the active space: each space has its own (Settings › EML Plugins). */
export function usePluginStates() {
  const space = useActiveSpace()?.id ?? null;
  return useQuery({ queryKey: [...pluginsKey, space], queryFn: () => requestPlugins(space), staleTime: 60_000 });
}

/**
 * Whether a view can be shown: the session views always, a plugin while it is
 * on in the active space. Until the host has answered every plugin counts as
 * on, so a pane showing one does not flip to another view while the page loads.
 */
export function useViewEnabled(): (view: PaneView) => boolean {
  const states = usePluginStates().data;
  return (view) => {
    const plugin = paneViewDef(view).plugin;
    return !plugin || !states || states[plugin] !== false;
  };
}

/** Switches a plugin on or off in the active space. */
export function useSetPluginEnabled() {
  const qc = useQueryClient();
  const space = useActiveSpace()?.id ?? null;
  return useMutation({
    mutationFn: ({ id, enabled }: { id: PluginId; enabled: boolean }) =>
      requestPlugins(null, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, enabled, ...(space ? { space } : {}) }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: pluginsKey }),
  });
}
