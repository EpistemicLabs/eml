// Settings › Plugins › Add plugin: any MCP server, by command or URL, becomes
// a custom plugin with an mcp part. Its secret values are stored once in a
// sign-in of its own; the plain ones go into the plugin.
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { idFromName, useAddCustomMcp } from '@/lib/plugins-admin';
import type { SpaceInfo } from '@/stores/useSpaceStore';

import SettingsSection from '../../SettingsSection';
import SettingsSegmented from '../../SettingsSegmented';

type Row = { name: string; value: string; secret: boolean };

const input = 'mt-1 w-full rounded-md border border-foreground/10 bg-background px-2 py-1 text-sm';

export default function AddCustomMcp({ spaces, locked, onAdded }: { spaces: SpaceInfo[]; locked: boolean; onAdded: (id: string) => void }) {
  const add = useAddCustomMcp();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [target, setTarget] = useState('');
  const [args, setArgs] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);

  if (locked) {
    return <SettingsSection title="Add custom MCP" description="Custom MCP servers are added on the cockpit's own machine: they run with your user rights there." ><span /></SettingsSection>;
  }
  const id = idFromName(name);
  const rowsValid = rows.every((r) => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(r.name) && r.value !== '');
  const complete = id !== '' && target.trim() !== '' && rowsValid;
  const setRow = (index: number, change: Partial<Row>) => setRows(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));

  return (
    <SettingsSection title="Add custom MCP" description="Any MCP server, by command or URL. It becomes a plugin with an mcp part, switched on in the spaces you pick.">
      <p className="rounded-lg border border-foreground/10 bg-foreground/4 px-3 py-2 text-sm"><b>Runs with your user rights.</b> The server starts as its own process on this machine and can do what your user can. It only gets the values you enter here.</p>
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
        <label className="block text-sm">
          <span className="text-muted-foreground">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pipedrive" autoComplete="off" className={input} />
          {id && <span className="mt-1 block font-mono text-xs text-muted-foreground">id {id} · its tools: mcp__{id}__…</span>}
        </label>
        <div className="text-sm">
          <span className="mb-1 block text-muted-foreground">How it runs</span>
          <SettingsSegmented<'stdio' | 'http'> value={transport} onChange={setTransport} ariaLabel="Transport" options={[{ value: 'stdio', label: 'Command' }, { value: 'http', label: 'URL' }]} />
        </div>
        <label className="block text-sm">
          <span className="text-muted-foreground">{transport === 'stdio' ? 'Command' : 'URL'}</span>
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={transport === 'stdio' ? 'npx' : 'https://mcp.example.com/mcp'} autoComplete="off" className={`${input} font-mono`} />
        </label>
        {transport === 'stdio' && (
          <label className="block text-sm">
            <span className="text-muted-foreground">Arguments, one per line</span>
            <textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={3} placeholder={'-y\n@vendor/mcp-server'} className={`${input} font-mono`} />
          </label>
        )}
        <div className="space-y-2 text-sm">
          <span className="block text-muted-foreground">{transport === 'stdio' ? 'Environment' : 'Headers'}</span>
          {rows.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <input aria-label="Name" value={row.name} onChange={(e) => setRow(index, { name: e.target.value })} placeholder="API_KEY" className="w-40 rounded-md border border-foreground/10 bg-background px-2 py-1 font-mono text-xs" />
              <input aria-label="Value" type={row.secret ? 'password' : 'text'} autoComplete="off" value={row.value} onChange={(e) => setRow(index, { value: e.target.value })} className="min-w-0 flex-1 rounded-md border border-foreground/10 bg-background px-2 py-1 font-mono text-xs" />
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input type="checkbox" checked={row.secret} onChange={(e) => setRow(index, { secret: e.target.checked })} /> secret
              </label>
              <button type="button" aria-label="Remove this value" onClick={() => setRows(rows.filter((_, i) => i !== index))} className="rounded-md p-1 text-muted-foreground hover:bg-foreground/8">
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setRows([...rows, { name: '', value: '', secret: true }])} className="inline-flex items-center gap-1 rounded-full border border-foreground/10 px-3 py-1 text-xs hover:bg-foreground/4">
            <Plus className="size-3" aria-hidden="true" /> Add a value
          </button>
          <p className="text-xs text-muted-foreground">Secret values are stored once, readable by you only, and never shown again.</p>
        </div>
        <fieldset className="text-sm">
          <legend className="mb-1 text-muted-foreground">Switch on in</legend>
          <div className="flex flex-wrap gap-2">
            {spaces.map((space) => (
              <label key={space.id} className="flex items-center gap-1.5 rounded-full border border-foreground/10 px-3 py-1">
                <input type="checkbox" checked={chosen.includes(space.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, space.id] : chosen.filter((s) => s !== space.id))} />
                {space.name}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" disabled={!complete || add.isPending} className="rounded-full bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50">Add plugin</button>
        {add.isError && <p className="text-sm text-destructive">{add.error.message}</p>}
      </form>
    </SettingsSection>
  );
}
