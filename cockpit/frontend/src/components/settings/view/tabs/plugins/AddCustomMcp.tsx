// Settings › Plugins › Add plugin (mockup v3): any MCP server, by command or
// URL, becomes a custom plugin with an mcp part. Its secret values are stored
// once in a sign-in of its own; the plain ones go into the plugin.
import { ChevronLeft, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { idFromName, useAddCustomMcp } from '@/lib/plugins-admin';
import { cn } from '@/lib/utils';
import { Button, Chip, FOCUS, HUE, Input, Select } from '@/shared/view/ui';
import type { SpaceInfo } from '@/stores/useSpaceStore';

type Row = { name: string; value: string; secret: boolean };

/** A value row's fields: compact, in the code font. */
const ROW_FIELD = 'min-h-(--target-min) px-2 font-code text-ui';

/** A command line split into the command and its arguments, at spaces outside quotes. */
export function splitCommand(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

export default function AddCustomMcp({ spaces, onAdded }: { spaces: SpaceInfo[]; onAdded: (id: string) => void }) {
  const [form, setForm] = useState(false);
  if (form) return <CustomForm spaces={spaces} onAdded={onAdded} onCancel={() => setForm(false)} />;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="min-w-0">
        <b className="text-body text-foreground">Add custom MCP</b>
        <p className="text-ui text-muted-foreground">Any MCP server, by command or URL. It becomes a plugin with an mcp part.</p>
      </div>
      <Button size="sm" onClick={() => setForm(true)}>Add custom MCP…</Button>
    </div>
  );
}

function CustomForm({ spaces, onAdded, onCancel }: { spaces: SpaceInfo[]; onAdded: (id: string) => void; onCancel: () => void }) {
  const add = useAddCustomMcp();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [target, setTarget] = useState('');
  const [rows, setRows] = useState<Row[]>([{ name: '', value: '', secret: true }]);
  const [chosen, setChosen] = useState<string[]>([]);

  const id = idFromName(name);
  // An empty row left over is no value.
  const values = rows.filter((r) => r.name !== '' || r.value !== '');
  const valuesOk = values.every((r) => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(r.name) && r.value !== '');
  const parts = splitCommand(target.trim());
  const complete = id !== '' && parts.length > 0 && valuesOk;
  const setRow = (index: number, change: Partial<Row>) => setRows(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));

  return (
    <div className="space-y-4">
      <Button variant="outline" size="sm" aria-label="Back to Add plugin" onClick={onCancel}><ChevronLeft aria-hidden="true" /> Add plugin</Button>
      <h3 className="text-title font-semibold text-foreground">Add custom MCP</h3>
      <p className={cn('rounded-lg border px-3 py-2 text-body text-foreground', HUE.you.edge, HUE.you.tint)}>
        <b className={HUE.you.ink}>Runs with your user rights.</b> The server starts as its own process on the cockpit's machine and can do what your user can. It only gets the values you enter here. From another device it can be added once remote access lets the shell in too (eml-cockpit remote shell on).
      </p>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const [command, ...args] = parts;
          add.mutate(
            { id, name: name.trim(), transport, target: transport === 'stdio' ? command : target.trim(), args: transport === 'stdio' ? args : [], values, spaces: chosen },
            { onSuccess: () => onAdded(id) },
          );
        }}
      >
        <label className="flex flex-col gap-1 text-body">
          <span className="text-ui font-semibold text-muted-foreground">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pipedrive" autoComplete="off" />
          {id && <span className="font-code text-ui text-muted-foreground">its tools: mcp__{id}__…</span>}
        </label>
        <label className="flex flex-col gap-1 text-body">
          <span className="text-ui font-semibold text-muted-foreground">How it runs</span>
          <Select value={transport} onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}>
            <option value="stdio">Command (stdio)</option>
            <option value="http">URL (HTTP)</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-body">
          <span className="text-ui font-semibold text-muted-foreground">Command or URL</span>
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={transport === 'stdio' ? 'npx -y @vendor/mcp-server' : 'https://mcp.example.com/mcp'} autoComplete="off" className="font-code" />
        </label>
        <div className="flex flex-col gap-1.5 text-body">
          <span className="text-ui font-semibold text-muted-foreground">{transport === 'stdio' ? 'Environment and secrets' : 'Headers and secrets'}</span>
          {rows.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-1.5">
              <Input aria-label="Variable name" value={row.name} onChange={(e) => setRow(index, { name: e.target.value })} placeholder={transport === 'stdio' ? 'API_KEY' : 'Authorization'} className={cn('w-40', ROW_FIELD)} />
              <Input aria-label={row.secret ? 'Secret value' : 'Value'} type={row.secret ? 'password' : 'text'} autoComplete="off" value={row.value} onChange={(e) => setRow(index, { value: e.target.value })} className={cn('w-auto min-w-0 flex-1', ROW_FIELD)} />
              <button type="button" aria-pressed={row.secret} onClick={() => setRow(index, { secret: !row.secret })} className={cn('rounded-full', FOCUS)} title="Switch between secret and plain">
                <Chip className={cn('min-h-(--target-min)', row.secret && 'text-foreground')}>{row.secret ? 'secret' : 'plain'}</Chip>
              </button>
              <Button variant="ghost" size="icon-sm" aria-label="Remove this value" onClick={() => setRows(rows.filter((_, i) => i !== index))}>
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="self-start" onClick={() => setRows([...rows, { name: '', value: '', secret: true }])}>
            <Plus aria-hidden="true" /> Add a value
          </Button>
          <span className="text-ui text-muted-foreground">Secrets are stored once, readable by the owner only, and never shown again.</span>
        </div>
        <fieldset className="flex flex-col gap-1.5 text-body">
          <legend className="mb-1 text-ui font-semibold text-muted-foreground">Switch on in</legend>
          <div className="flex flex-wrap gap-1.5">
            {spaces.map((space) => (
              <label key={space.id} className="flex min-h-(--target-min) cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 text-foreground hover:bg-muted">
                <input type="checkbox" className="accent-foreground" checked={chosen.includes(space.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, space.id] : chosen.filter((s) => s !== space.id))} />
                {space.name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex gap-2">
          <Button type="submit" disabled={!complete} loading={add.isPending}>Add plugin</Button>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
        {add.isError && <p className="text-body text-stopped-ink">{add.error.message}</p>}
      </form>
    </div>
  );
}
