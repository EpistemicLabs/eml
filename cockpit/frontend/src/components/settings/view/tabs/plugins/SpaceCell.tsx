// One plugin's switch in one space, and the sign-ins it uses there (Settings › Plugins: the Spaces
// table and the plugin page). A space may use several sign-ins of one plugin, each its own server.
import { useSetPlugin, type ConnectionView, type PluginView } from '@/lib/plugins-admin';
import { cn } from '@/lib/utils';
import { Chip, FOCUS, HUE, Switch } from '@/shared/view/ui';
import type { SpaceInfo } from '@/stores/useSpaceStore';

import { needsSignIn } from './shared';

/** The sign-ins a plugin uses in a space: a label for the only one, a toggle chip each where there are several. */
export function SignInPicker({ plugin, space, connections }: { plugin: PluginView; space: SpaceInfo; connections: ConnectionView[] }) {
  const setPlugin = useSetPlugin();
  const on = space.id in plugin.spaces;
  const own = connections.filter((c) => c.plugin === plugin.id);
  const picked = plugin.spaces[space.id] ?? [];
  if (!on || !needsSignIn(plugin)) return <span className="text-ui text-muted-foreground">–</span>;
  if (own.length === 0) return <span className={cn('text-ui', HUE.you.ink)}>needs a sign-in</span>;
  if (own.length === 1) return <span className="text-ui text-foreground">{own[0].label}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {own.map((c) => {
        const active = picked.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={active}
            aria-label={`${plugin.name} ${c.label} in ${space.name}`}
            disabled={setPlugin.isPending}
            onClick={() => setPlugin.mutate({ id: plugin.id, space: space.id, enabled: true, connections: active ? picked.filter((p) => p !== c.id) : [...picked, c.id] })}
            className={cn('rounded-full', FOCUS)}
          >
            <Chip className={cn('min-h-(--target-min)', active ? 'bg-foreground text-background' : 'border border-border bg-transparent')}>{c.label}</Chip>
          </button>
        );
      })}
      {picked.length === 0 && <span className={cn('text-ui', HUE.you.ink)}>pick one</span>}
    </span>
  );
}

/** A plugin's switch in one space, with its sign-ins there. */
export default function SpaceCell({ plugin, space, connections }: { plugin: PluginView; space: SpaceInfo; connections: ConnectionView[] }) {
  const setPlugin = useSetPlugin();
  const on = space.id in plugin.spaces;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Switch
        checked={on}
        disabled={setPlugin.isPending}
        onChange={(enabled) => setPlugin.mutate({ id: plugin.id, space: space.id, enabled })}
        ariaLabel={`${plugin.name} in ${space.name}`}
      />
      {on && needsSignIn(plugin) && <SignInPicker plugin={plugin} space={space} connections={connections} />}
      {setPlugin.isError && <span className="text-ui text-stopped-ink">{setPlugin.error.message}</span>}
    </div>
  );
}
