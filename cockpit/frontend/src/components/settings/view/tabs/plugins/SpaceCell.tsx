// One plugin's switch in one space, with the sign-in it uses there when the
// user has more than one for it (Settings › Plugins: the matrix and the detail).
import { useSetPlugin, type ConnectionView, type PluginView } from '@/lib/plugins-admin';
import { Select, Switch } from '@/shared/view/ui';
import type { SpaceInfo } from '@/stores/useSpaceStore';

/** A plugin's switch in one space, with the sign-in it uses there when it has a choice. */
export default function SpaceCell({ plugin, space, connections }: { plugin: PluginView; space: SpaceInfo; connections: ConnectionView[] }) {
  const setPlugin = useSetPlugin();
  const on = space.id in plugin.spaces;
  const own = connections.filter((c) => c.plugin === plugin.id);
  const current = plugin.spaces[space.id] ?? null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Switch
        checked={on}
        disabled={setPlugin.isPending}
        onChange={(enabled) => setPlugin.mutate({ id: plugin.id, space: space.id, enabled })}
        ariaLabel={`${plugin.name} in ${space.name}`}
      />
      {on && own.length > 1 && (
        <Select
          aria-label={`${plugin.name} sign-in in ${space.name}`}
          value={current ?? ''}
          onChange={(event) => setPlugin.mutate({ id: plugin.id, space: space.id, enabled: true, connection: event.target.value || null })}
          className="min-h-(--target-min) max-w-40 px-2 text-ui"
        >
          <option value="">No sign-in</option>
          {own.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Select>
      )}
      {on && own.length === 1 && <span className="text-ui text-muted-foreground">{own[0].label}</span>}
      {on && own.length === 0 && (plugin.auth || plugin.mcp?.settings.some((s) => s.secret)) && <span className="text-ui text-you-ink">needs a sign-in</span>}
      {setPlugin.isError && <span className="text-ui text-stopped-ink">{setPlugin.error.message}</span>}
    </div>
  );
}
