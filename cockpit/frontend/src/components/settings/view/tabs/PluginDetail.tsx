// Settings › Plugins › one plugin: its parts and the user's
// sign-ins side by side, the spaces it is on in, and what its tier lets it do.
import { ChevronLeft } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import {
  useAddConnection,
  useRemoveConnection,
  useRemoveCustom,
  useSetPart,
  useSetPlugin,
  type ConnectionView,
  type PluginView,
} from '@/lib/plugins-admin';
import { cn } from '@/lib/utils';
import { Button, HUE, Input, LABEL, Switch } from '@/shared/view/ui';
import type { SpaceInfo } from '@/stores/useSpaceStore';

import SettingsPanel, { SettingsPanelLine } from '../SettingsPanel';
import { GoogleSignIn, GoogleSignInAgain } from './GoogleSignIn';
import { PART_LABEL, PluginIcon, SlugField, TierChip, needsSignIn, trustNote } from './PluginShared';
import { SignInPicker } from './PluginSpaceCell';

/** The values a gmail sign-in holds for the channel bridge (plugins/gmail/channel). */
const GMAIL_FIELDS = ['address', 'credentialsFile', 'tokenFile'];

const partNote = (plugin: PluginView, part: PluginView['parts'][number]) => ({
  pane: 'UI in a pane, next to the sessions',
  mcp: plugin.channel ? 'Tools for your own sessions (jobs send through the bridge)' : 'Tools the agent can call',
  channel: 'Incoming messages wake the matching job; replies leave through the bridge outbox',
}[part]);

export default function PluginDetail({ plugin, spaces, connections, onBack }: {
  plugin: PluginView;
  spaces: SpaceInfo[];
  connections: ConnectionView[];
  onBack: () => void;
}) {
  const setPart = useSetPart();
  const setPlugin = useSetPlugin();
  const removeConnection = useRemoveConnection();
  const removeCustom = useRemoveCustom();
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** The sign-in whose "Sign in again" steps are open, under its line. */
  const [againFor, setAgainFor] = useState<string | null>(null);
  const own = connections.filter((c) => c.plugin === plugin.id);
  const onIn = Object.keys(plugin.spaces).length;
  const google = plugin.auth?.kind === 'google-oauth';
  const cell = 'px-3 py-2 align-middle';

  return (
    <div className="space-y-4">
      <Button variant="outline" size="sm" aria-label="Back to the plugins" onClick={onBack}><ChevronLeft aria-hidden="true" /> Plugins</Button>
      <div className="flex flex-wrap items-center gap-3">
        <PluginIcon plugin={plugin} large />
        <div className="min-w-0">
          <h3 className="text-title font-semibold text-foreground">{plugin.name}</h3>
          {plugin.description && <p className="text-body text-muted-foreground">{plugin.description}</p>}
          <div className="mt-1.5 flex gap-1"><TierChip tier={plugin.tier} /></div>
        </div>
      </div>
      {plugin.tier === 'custom' && (
        <p className={cn('rounded-lg border px-3 py-2 text-body text-foreground', HUE.you.edge, HUE.you.tint)}>
          <b className={HUE.you.ink}>Runs with your user rights.</b> A custom MCP server can do what your user account can do on this machine. Only add servers you trust.
        </p>
      )}

      <div className="grid grid-cols-(--grid-plugin-panels) items-start gap-3">
        <SettingsPanel title="Parts">
          {plugin.parts.map((part) => (
            <SettingsPanelLine key={part} label={PART_LABEL[part]} note={part === 'mcp' && plugin.mcp ? `${partNote(plugin, part)} · ${plugin.mcp.target}` : partNote(plugin, part)}>
              <Switch
                checked={!plugin.partsOff.includes(part)}
                disabled={setPart.isPending || plugin.parts.length === 1}
                onChange={(enabled) => setPart.mutate({ id: plugin.id, part, enabled })}
                ariaLabel={`${plugin.name} ${PART_LABEL[part]}`}
              />
            </SettingsPanelLine>
          ))}
          {setPart.isError && <p className="text-ui text-stopped-ink">{setPart.error.message}</p>}
        </SettingsPanel>

        <SettingsPanel title="Sign-ins">
          {!needsSignIn(plugin) && <p className="text-body text-muted-foreground">This plugin needs no sign-in.</p>}
          {needsSignIn(plugin) && own.length === 0 && <p className={cn('text-body', HUE.you.ink)}>No sign-in yet: add one to use it in a space.</p>}
          {own.map((connection) => (
            <div key={connection.id} className="border-t border-border first-of-type:border-t-0">
              <SettingsPanelLine
                label={connection.label}
                note={`Connected${plugin.mcp ? ` · its tools: ${plugin.id}${connection.slug ? `-${connection.slug}` : ''}` : ''} · secret stored once, owner only, never shown`}
              >
                {google && againFor !== connection.id && <Button variant="outline" size="sm" onClick={() => setAgainFor(connection.id)}>Sign in again</Button>}
                <Button variant="outline" size="sm" onClick={() => removeConnection.mutate(connection.id)} disabled={removeConnection.isPending}>Remove</Button>
              </SettingsPanelLine>
              {google && againFor === connection.id && <GoogleSignInAgain plugin={plugin} connection={connection} onClose={() => setAgainFor(null)} />}
            </div>
          ))}
          {google && <GoogleSignIn plugin={plugin} another={own.length > 0} />}
          {needsSignIn(plugin) && !google && <AddSignIn plugin={plugin} another={own.length > 0} />}
          {google && <AddSignIn plugin={plugin} another={own.length > 0} manual />}
        </SettingsPanel>
      </div>

      <SettingsPanel title="Spaces">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-body">
            <thead className="bg-muted">
              <tr className={cn('text-left', LABEL)}><th className={cell}>Space</th><th className={cell}>On</th><th className={cell}>Sign-in</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {spaces.map((space) => {
                const on = space.id in plugin.spaces;
                return (
                  <tr key={space.id}>
                    <td className={cell}>
                      {space.name}
                      <span className="text-ui text-muted-foreground"> · {space.agentName ?? space.agent ?? 'no agent'}{space.shared ? ' · shared' : ''}</span>
                    </td>
                    <td className={cell}>
                      <Switch checked={on} disabled={setPlugin.isPending} onChange={(enabled) => setPlugin.mutate({ id: plugin.id, space: space.id, enabled })} ariaLabel={`${plugin.name} in ${space.name}`} />
                    </td>
                    <td className={cell}><SignInPicker plugin={plugin} space={space} connections={connections} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {setPlugin.isError && <p className="text-ui text-stopped-ink">{setPlugin.error.message}</p>}
        {plugin.channel && (
          <p className="text-ui text-muted-foreground">
            Incoming messages are routed across all {onIn} space{onIn === 1 ? '' : 's'} where this plugin is on: thread owner first, then exact address, then verified domain. Unmatched or ambiguous ones show in the inbox of each of those spaces.
          </p>
        )}
      </SettingsPanel>

      <SettingsPanel title="Trust and permissions">
        <p className="text-body text-muted-foreground">{trustNote(plugin.tier)}</p>
        {plugin.tier === 'custom' && (
          <SettingsPanelLine label="Remove plugin" note="Its sign-ins and secrets are deleted from this cockpit.">
            {confirmRemove ? (
              <>
                <Button variant="destructive" size="sm" onClick={() => removeCustom.mutate(plugin.id, { onSuccess: onBack })} loading={removeCustom.isPending}>Remove</Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmRemove(false)}>Cancel</Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirmRemove(true)}>Remove…</Button>
            )}
          </SettingsPanelLine>
        )}
        {removeCustom.isError && <p className="text-ui text-stopped-ink">{removeCustom.error.message}</p>}
      </SettingsPanel>
    </div>
  );
}

/** A new sign-in: the values the plugin's settings name (a custom server's secrets, a Gmail mailbox's files). */
function AddSignIn({ plugin, another, manual = false }: { plugin: PluginView; another: boolean; manual?: boolean }) {
  const add = useAddConnection();
  const gmail = plugin.channel === 'gmail';
  const names = gmail ? GMAIL_FIELDS : (plugin.mcp?.settings.filter((s) => s.secret).map((s) => s.name) ?? []);
  const [label, setLabel] = useState('');
  const [slug, setSlug] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [openForm, setOpenForm] = useState(false);
  if (!openForm) {
    if (manual) {
      return <button type="button" className="self-start text-ui text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setOpenForm(true)}>or use the files of an existing sign-in</button>;
    }
    return (
      <Button variant="outline" size="sm" className="self-start" onClick={() => setOpenForm(true)}>
        {another ? 'Add another sign-in' : 'Add a sign-in'}
      </Button>
    );
  }
  const complete = label.trim() !== '' && names.every((name) => (values[name] ?? '') !== '');
  return (
    <form
      className="space-y-3 border-t border-border pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate({ plugin: plugin.id, label: label.trim(), values, slug: slug || undefined }, { onSuccess: () => { setOpenForm(false); setLabel(''); setSlug(''); setValues({}); } });
      }}
    >
      <label className="block text-body">
        <span className="text-muted-foreground">Name it</span>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={gmail ? 'Work mailbox' : 'Workspace'} className="mt-1" />
      </label>
      {plugin.mcp && <SlugField plugin={plugin} value={slug} onChange={setSlug} />}
      {names.map((name) => (
        <label key={name} className="block text-body">
          <span className="font-code text-ui text-muted-foreground">{name}</span>
          <Input
            type={gmail ? 'text' : 'password'}
            autoComplete="off"
            value={values[name] ?? ''}
            onChange={(e) => setValues({ ...values, [name]: e.target.value })}
            className="mt-1 font-code text-ui"
          />
        </label>
      ))}
      {gmail && <p className="text-ui text-muted-foreground">The mailbox's address, an OAuth Desktop app client file and the token file of an existing sign-in; the bridge only reads the files.</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!complete || add.isPending}>Save sign-in</Button>
        <Button variant="outline" size="sm" onClick={() => setOpenForm(false)}>Cancel</Button>
      </div>
      {add.isError && <p className="text-ui text-stopped-ink">{add.error.message}</p>}
    </form>
  );
}
