// An OAuth sign-in to a remote MCP server (Qonto, Notion …): the server's sign-in page opens in a
// new tab and sends the browser back to the cockpit's loopback address. On this machine that lands
// by itself; through remote access the tab ends on a page that can't load, and its address is
// pasted here. The cockpit keeps the sign-in and renews it. Several sign-ins of one plugin are
// several accounts; each space picks the one it uses.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useFinishMcpOAuth, useStartMcpOAuth, type ConnectionView, type PluginView } from '@/lib/plugins-admin';
import { Button, Input } from '@/shared/view/ui';

import { SlugField } from './PluginShared';

/** Opens the sign-in page in a tab opened on the click itself, so no popup blocker stops it. */
function useOpenConsent() {
  const start = useStartMcpOAuth();
  const [paste, setPaste] = useState(false);
  const open = (input: Parameters<typeof start.mutate>[0]) => {
    const tab = window.open('', '_blank');
    start.mutate(input, {
      onSuccess: ({ url, paste: needsPaste }) => {
        setPaste(needsPaste);
        if (tab) tab.location.href = url; else window.location.href = url;
      },
      onError: () => tab?.close(),
    });
  };
  return { open, start, paste, done: () => setPaste(false) };
}

/** The sign-ins come back from another tab: the list is read again when this one is in front again. */
export function useRefreshOnReturn() {
  const qc = useQueryClient();
  useEffect(() => {
    const again = () => { void qc.invalidateQueries({ queryKey: ['plugins-admin'] }); };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [qc]);
}

/** The step after the sign-in page when the browser can't reach the cockpit's loopback address. */
export function PasteAddress({ onDone }: { onDone: () => void }) {
  const [address, setAddress] = useState('');
  const finish = useFinishMcpOAuth();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-ui text-muted-foreground">
        After you signed in, the new tab shows a page that can't be reached (its address starts with http://127.0.0.1). That is expected here: copy that whole address and paste it below.
      </p>
      <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://127.0.0.1:4317/api/plugins/oauth/callback?code=…" className="font-code text-ui" />
      <div className="flex gap-2">
        <Button size="sm" disabled={!address.trim() || finish.isPending} onClick={() => finish.mutate(address, { onSuccess: onDone })}>
          {finish.isPending ? 'Finishing…' : 'Finish sign-in'}
        </Button>
        <Button size="sm" variant="outline" onClick={onDone}>Cancel</Button>
      </div>
      {finish.isError && <p className="text-ui text-stopped-ink">{finish.error.message}</p>}
    </div>
  );
}

export function McpOAuthSignIn({ plugin, another }: { plugin: PluginView; another: boolean }) {
  const [label, setLabel] = useState('');
  const [slug, setSlug] = useState('');
  const { open, start, paste, done } = useOpenConsent();
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <p className="text-ui text-muted-foreground">
        {another ? 'Another account of this server' : 'Sign in to this server'}: its sign-in page opens in a new tab. The cockpit keeps the sign-in and renews it, so sessions never need to sign in themselves.
      </p>
      {paste ? <PasteAddress onDone={() => { done(); setLabel(''); setSlug(''); }} /> : (
        <>
          <label className="text-ui text-muted-foreground">
            Name
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={another ? 'Company B' : 'Company A'} className="mt-1" />
          </label>
          {another && <SlugField plugin={plugin} value={slug} onChange={setSlug} />}
          <div>
            <Button size="sm" disabled={start.isPending} onClick={() => open({ plugin: plugin.id, label: label.trim() || undefined, slug: slug || undefined })}>
              {start.isPending ? 'Opening…' : 'Sign in'}
            </Button>
          </div>
          {another && <p className="text-ui text-muted-foreground">A short name lets both accounts run in one space (tools {plugin.id}-&lt;short name&gt;). Leave it empty when each space uses one account: the tools stay {plugin.id}.</p>}
        </>
      )}
      {start.isError && <p className="text-ui text-stopped-ink">{start.error.message}</p>}
    </div>
  );
}

/** The button on a sign-in's line; `onPaste` opens the paste step under the line when it is needed. */
export function McpOAuthSignInAgain({ plugin, connection, onPaste }: { plugin: PluginView; connection: ConnectionView; onPaste: () => void }) {
  const start = useStartMcpOAuth();
  const open = () => {
    const tab = window.open('', '_blank');
    start.mutate({ plugin: plugin.id, connection: connection.id }, {
      onSuccess: ({ url, paste }) => {
        if (paste) onPaste();
        if (tab) tab.location.href = url; else window.location.href = url;
      },
      onError: () => tab?.close(),
    });
  };
  return (
    <>
      <Button variant={connection.signInNeeded ? 'default' : 'outline'} size="sm" disabled={start.isPending} onClick={open}>Sign in again</Button>
      {start.isError && <span className="text-ui text-stopped-ink">{start.error.message}</span>}
    </>
  );
}
