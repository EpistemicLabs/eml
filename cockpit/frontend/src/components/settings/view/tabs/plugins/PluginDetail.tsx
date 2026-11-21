// Settings › Plugins › one plugin: its parts, the user's sign-ins for it, the
// spaces it is on in, and what its tier lets it do.
import { ChevronLeft, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  useAddConnection,
  useRemoveConnection,
  useRemoveCustom,
  useSetPart,
  type ConnectionView,
  type PluginView,
} from '@/lib/plugins-admin';
import { Switch } from '@/shared/view/ui';
import type { SpaceInfo } from '@/stores/useSpaceStore';

import SettingsCard from '../../SettingsCard';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import SpaceCell from './SpaceCell';
import { PART_LABEL, PluginIcon, TierChip, trustNote } from './shared';

/** The values a gmail sign-in holds for the channel bridge (plugins/gmail/channel). */
const GMAIL_FIELDS = ['address', 'credentialsFile', 'tokenFile'];

const partNote = (plugin: PluginView, part: PluginView['parts'][number]) => ({
  pane: 'A view in a pane, next to the sessions.',
  mcp: plugin.channel ? 'Read and lookup tools; sending goes through the bridge.' : 'Tools the agent can call.',
  channel: 'Incoming messages wake the job they belong to; replies leave through the bridge\'s outbox.',
}[part]);

export default function PluginDetail({ plugin, spaces, connections, connectionsLocked, onBack }: {
  plugin: PluginView;
  spaces: SpaceInfo[];
  connections: ConnectionView[];
  /** Sign-ins are managed on this machine only. */
  connectionsLocked: boolean;
  onBack: () => void;
}) {
  const setPart = useSetPart();
  const removeConnection = useRemoveConnection();
  const removeCustom = useRemoveCustom();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const own = connections.filter((c) => c.plugin === plugin.id);
  const needsSignIn = !!plugin.auth || !!plugin.mcp?.settings.some((s) => s.secret);
  const onIn = Object.keys(plugin.spaces).length;

  return (
    <div className="space-y-6">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 rounded-md border border-foreground/10 px-2 py-1 text-sm hover:bg-foreground/4">
        <ChevronLeft className="size-4" aria-hidden="true" /> Plugins
      </button>
      <div className="flex items-center gap-3">
        <PluginIcon plugin={plugin} large />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{plugin.name}</h2>
          {plugin.description && <p className="text-sm text-muted-foreground">{plugin.description}</p>}
          <div className="mt-1 flex gap-1"><TierChip tier={plugin.tier} /></div>
        </div>
      </div>
      {plugin.tier === 'custom' && (
        <p className="rounded-lg border border-foreground/10 bg-foreground/4 px-3 py-2 text-sm"><b>Runs with your user rights.</b> A custom MCP server can do what your user account can do on this machine.</p>
      )}

      <SettingsSection title="Parts" description="Switched off, a part is off in every space; the plugin itself stays on where it is.">
        <SettingsCard divided>
          {plugin.parts.map((part) => (
            <SettingsRow key={part} label={PART_LABEL[part]} description={part === 'mcp' && plugin.mcp ? `${partNote(plugin, part)} ${plugin.mcp.transport === 'stdio' ? 'Runs' : 'Reaches'} ${plugin.mcp.target}.` : partNote(plugin, part)}>
              <Switch
                checked={!plugin.partsOff.includes(part)}
                disabled={setPart.isPending || plugin.parts.length === 1}
                onChange={(enabled) => setPart.mutate({ id: plugin.id, part, enabled })}
                ariaLabel={`${plugin.name} ${PART_LABEL[part]}`}
              />
            </SettingsRow>
          ))}
        </SettingsCard>
        {setPart.isError && <p className="text-sm text-destructive">{setPart.error.message}</p>}
      </SettingsSection>

      {needsSignIn && (
        <SettingsSection title="Sign-ins" description="Stored once in this cockpit, readable by you only and never shown again; each space picks one.">
          {connectionsLocked ? (
            <p className="text-sm text-muted-foreground">Sign-ins are managed on the cockpit's own machine.</p>
          ) : (
            <>
              <SettingsCard divided>
                {own.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">No sign-in yet.</p>}
                {own.map((connection) => (
                  <SettingsRow key={connection.id} label={connection.label} description={`Holds ${connection.secrets.join(', ') || 'nothing'} · used in ${Object.values(plugin.spaces).filter((c) => c === connection.id).length} space(s)`}>
                    <button
                      type="button"
                      aria-label={`Remove ${connection.label}`}
                      onClick={() => removeConnection.mutate(connection.id)}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </SettingsRow>
                ))}
              </SettingsCard>
              <AddSignIn plugin={plugin} />
            </>
          )}
        </SettingsSection>
      )}

      <SettingsSection title="Spaces" description={plugin.channel ? `Incoming messages are routed across all ${onIn} space${onIn === 1 ? '' : 's'} where this plugin is on: thread owner first, then exact address, then verified domain. What no job takes waits in the inbox of each.` : undefined}>
        <SettingsCard divided>
          {spaces.map((space) => (
            <div key={space.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span className="text-sm">
                {space.name}
                <span className="text-muted-foreground"> · {space.agentName ?? space.agent ?? 'no agent'}{space.shared ? ' · shared' : ''}</span>
              </span>
              <SpaceCell plugin={plugin} space={space} connections={connections} />
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Trust and permissions" description={trustNote(plugin.tier)}>
        {plugin.tier === 'custom' && (
          <SettingsCard>
            <SettingsRow label="Remove plugin" description="It leaves every space, and its sign-ins are deleted from this cockpit.">
              {confirmRemove ? (
                <span className="flex gap-2">
                  <button type="button" onClick={() => removeCustom.mutate(plugin.id, { onSuccess: onBack })} className="rounded-full bg-destructive px-3 py-1 text-sm text-white">Remove</button>
                  <button type="button" onClick={() => setConfirmRemove(false)} className="rounded-full border border-foreground/10 px-3 py-1 text-sm">Cancel</button>
                </span>
              ) : (
                <button type="button" onClick={() => setConfirmRemove(true)} className="rounded-full border border-foreground/10 px-3 py-1 text-sm hover:bg-foreground/4">Remove…</button>
              )}
            </SettingsRow>
          </SettingsCard>
        )}
        {removeCustom.isError && <p className="text-sm text-destructive">{removeCustom.error.message}</p>}
      </SettingsSection>
    </div>
  );
}

/** A new sign-in: the values the plugin's settings name (a custom server's secrets, a Gmail mailbox's files). */
function AddSignIn({ plugin }: { plugin: PluginView }) {
  const add = useAddConnection();
  const names = plugin.channel === 'gmail' ? GMAIL_FIELDS : (plugin.mcp?.settings.filter((s) => s.secret).map((s) => s.name) ?? []);
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [openForm, setOpenForm] = useState(false);
  if (!openForm) {
    return <button type="button" onClick={() => setOpenForm(true)} className="rounded-full border border-foreground/10 px-3 py-1 text-sm hover:bg-foreground/4">Add a sign-in</button>;
  }
  const complete = label.trim() !== '' && names.every((name) => (values[name] ?? '') !== '');
  return (
    <form
      className="space-y-3 rounded-xl border border-foreground/8 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate({ plugin: plugin.id, label: label.trim(), values }, { onSuccess: () => { setOpenForm(false); setLabel(''); setValues({}); } });
      }}
    >
      <label className="block text-sm">
        <span className="text-muted-foreground">Name it</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={plugin.channel === 'gmail' ? 'Work mailbox' : 'Workspace'} className="mt-1 w-full rounded-md border border-foreground/10 bg-background px-2 py-1" />
      </label>
      {names.map((name) => (
        <label key={name} className="block text-sm">
          <span className="font-mono text-xs text-muted-foreground">{name}</span>
          <input
            type={plugin.channel === 'gmail' ? 'text' : 'password'}
            autoComplete="off"
            value={values[name] ?? ''}
            onChange={(e) => setValues({ ...values, [name]: e.target.value })}
            className="mt-1 w-full rounded-md border border-foreground/10 bg-background px-2 py-1 font-mono text-xs"
          />
        </label>
      ))}
      {plugin.channel === 'gmail' && <p className="text-xs text-muted-foreground">The mailbox's address, an OAuth Desktop app client file and the token file of an existing sign-in; the bridge only reads the files.</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!complete || add.isPending} className="rounded-full bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50">Save sign-in</button>
        <button type="button" onClick={() => setOpenForm(false)} className="rounded-full border border-foreground/10 px-3 py-1 text-sm">Cancel</button>
      </div>
      {add.isError && <p className="text-sm text-destructive">{add.error.message}</p>}
    </form>
  );
}
