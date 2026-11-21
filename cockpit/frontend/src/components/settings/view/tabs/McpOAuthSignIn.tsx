// An OAuth sign-in to a remote MCP server (Qonto, Notion …): the server's consent page opens in a
// new tab and comes back to the cockpit, which keeps the sign-in and renews it. Several sign-ins
// of one plugin are several accounts; each space picks the one it uses.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useStartMcpOAuth, type ConnectionView, type PluginView } from '@/lib/plugins-admin';
import { Button, Input } from '@/shared/view/ui';

import { SlugField } from './PluginShared';

/** Opens the consent page in a tab opened on the click itself, so no popup blocker stops it. */
function useOpenConsent() {
  const start = useStartMcpOAuth();
  const open = (input: Parameters<typeof start.mutate>[0]) => {
    const tab = window.open('', '_blank');
    start.mutate(input, {
      onSuccess: (url) => { if (tab) tab.location.href = url; else window.location.href = url; },
      onError: () => tab?.close(),
    });
  };
  return { open, start };
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

export function McpOAuthSignIn({ plugin, another }: { plugin: PluginView; another: boolean }) {
  const [label, setLabel] = useState('');
  const [slug, setSlug] = useState('');
  const { open, start } = useOpenConsent();
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <p className="text-ui text-muted-foreground">
        {another ? 'Another account of this server' : 'Sign in to this server'}: its sign-in page opens in a new tab and comes back here. The cockpit keeps the sign-in and renews it, so sessions never need to sign in themselves.
      </p>
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
      {start.isError && <p className="text-ui text-stopped-ink">{start.error.message}</p>}
    </div>
  );
}

export function McpOAuthSignInAgain({ plugin, connection }: { plugin: PluginView; connection: ConnectionView }) {
  const { open, start } = useOpenConsent();
  return (
    <>
      <Button variant={connection.signInNeeded ? 'default' : 'outline'} size="sm" disabled={start.isPending} onClick={() => open({ plugin: plugin.id, connection: connection.id })}>
        Sign in again
      </Button>
      {start.isError && <span className="text-ui text-stopped-ink">{start.error.message}</span>}
    </>
  );
}
