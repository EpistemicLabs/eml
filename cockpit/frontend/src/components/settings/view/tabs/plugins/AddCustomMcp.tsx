// Settings › Plugins › Add plugin: any MCP server, by command or URL, becomes
// a custom plugin with an mcp part. Its secret values are stored once in a
// sign-in of its own; the plain ones go into the plugin.
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { idFromName, useAddCustomMcp } from '@/lib/plugins-admin';
import { Button, Input, Textarea } from '@/shared/view/ui';
import type { SpaceInfo } from '@/stores/useSpaceStore';

import SettingsSection from '../../SettingsSection';
import SettingsSegmented from '../../SettingsSegmented';

type Row = { name: string; value: string; secret: boolean };

/** A value row's fields: compact, in the code font. */
const ROW_FIELD = 'min-h-(--target-min) px-2 font-code text-ui';

export default function AddCustomMcp({ spaces, onAdded }: { spaces: SpaceInfo[]; onAdded: (id: string) => void }) {
  const add = useAddCustomMcp();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [target, setTarget] = useState('');
  const [args, setArgs] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);

  const id = idFromName(name);
  const rowsValid = rows.every((r) => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(r.name) && r.value !== '');
  const complete = id !== '' && target.trim() !== '' && rowsValid;
  const setRow = (index: number, change: Partial<Row>) => setRows(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));

  return (
    <SettingsSection title="Add custom MCP" description="Any MCP server, by command or URL. It becomes a plugin with an mcp part, switched on in the spaces you pick.">
      <p className="rounded-lg border border-border bg-muted px-3 py-2 text-body text-foreground"><b>Runs with your user rights.</b> The server starts as its own process on the cockpit's machine and can do what your user can. It only gets the values you enter here. From another device it can be added once remote access lets the shell in too (eml-cockpit remote shell on).</p>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate(
            { id, name: name.trim(), transport, target: target.trim(), args: args.split('\n').map((a) => a.trim()).filter(Boolean), values: rows, spaces: chosen },
            { onSuccess: () => onAdded(id) },
          );
        }}
      >
        <label className="block text-body">
          <span className="text-muted-foreground">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pipedrive" autoComplete="off" className="mt-1" />
          {id && <span className="mt-1 block font-code text-ui text-muted-foreground">id {id} · its tools: mcp__{id}__…</span>}
        </label>
        <div className="text-body">
          <span className="mb-1 block text-muted-foreground">How it runs</span>
          <SettingsSegmented<'stdio' | 'http'> value={transport} onChange={setTransport} ariaLabel="Transport" options={[{ value: 'stdio', label: 'Command' }, { value: 'http', label: 'URL' }]} />
        </div>
        <label className="block text-body">
          <span className="text-muted-foreground">{transport === 'stdio' ? 'Command' : 'URL'}</span>
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={transport === 'stdio' ? 'npx' : 'https://mcp.example.com/mcp'} autoComplete="off" className="mt-1 font-code" />
        </label>
        {transport === 'stdio' && (
          <label className="block text-body">
            <span className="text-muted-foreground">Arguments, one per line</span>
            <Textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={3} placeholder={'-y\n@vendor/mcp-server'} className="mt-1 font-code" />
          </label>
        )}
        <div className="space-y-2 text-body">
          <span className="block text-muted-foreground">{transport === 'stdio' ? 'Environment' : 'Headers'}</span>
          {rows.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input aria-label="Name" value={row.name} onChange={(e) => setRow(index, { name: e.target.value })} placeholder="API_KEY" className={`w-40 ${ROW_FIELD}`} />
              <Input aria-label="Value" type={row.secret ? 'password' : 'text'} autoComplete="off" value={row.value} onChange={(e) => setRow(index, { value: e.target.value })} className={`w-auto min-w-0 flex-1 ${ROW_FIELD}`} />
              <label className="flex min-h-(--target-min) cursor-pointer items-center gap-1 text-ui text-muted-foreground">
                <input type="checkbox" className="accent-foreground" checked={row.secret} onChange={(e) => setRow(index, { secret: e.target.checked })} /> secret
              </label>
              <Button variant="ghost" size="icon-sm" aria-label="Remove this value" onClick={() => setRows(rows.filter((_, i) => i !== index))}>
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setRows([...rows, { name: '', value: '', secret: true }])}>
            <Plus aria-hidden="true" /> Add a value
          </Button>
          <p className="text-ui text-muted-foreground">Secret values are stored once, readable by you only, and never shown again.</p>
        </div>
        <fieldset className="text-body">
          <legend className="mb-1 text-muted-foreground">Switch on in</legend>
          <div className="flex flex-wrap gap-2">
            {spaces.map((space) => (
              <label key={space.id} className="flex min-h-(--target-min) cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 text-foreground hover:bg-muted">
                <input type="checkbox" className="accent-foreground" checked={chosen.includes(space.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, space.id] : chosen.filter((s) => s !== space.id))} />
                {space.name}
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" disabled={!complete || add.isPending}>Add plugin</Button>
        {add.isError && <p className="text-body text-stopped-ink">{add.error.message}</p>}
      </form>
    </SettingsSection>
  );
}
