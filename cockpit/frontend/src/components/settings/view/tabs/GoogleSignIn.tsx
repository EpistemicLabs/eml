// Settings › Plugins › Gmail: signing in to Google with the user's own OAuth client (host:
// google-sign-in.ts). The client once; then Google's consent page in a new tab, and back here the
// address the browser ended on — that address may not load, which is fine: it carries the code.
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';

import {
  useFinishGoogleSignIn,
  useGoogleClient,
  useSaveGoogleClient,
  useStartGoogleSignIn,
  type ConnectionView,
  type PluginView,
} from '@/lib/plugins-admin';
import { cn } from '@/lib/utils';
import { Button, FOCUS, Input, Textarea } from '@/shared/view/ui';

import { SlugField } from './PluginShared';

function ClientStep({ fromSignIns }: { fromSignIns: Array<{ id: string; label: string }> }) {
  const save = useSaveGoogleClient();
  const [text, setText] = useState('');
  return (
    <div className="space-y-2">
      {fromSignIns.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui text-muted-foreground">Use the OAuth client your earlier sign-in was made with:</span>
          {fromSignIns.map((c) => (
            <Button key={c.id} size="sm" variant="outline" loading={save.isPending} onClick={() => save.mutate({ fromConnection: c.id })}>{c.label}</Button>
          ))}
        </div>
      )}
      <p className="text-ui text-muted-foreground">
        First your own Google OAuth client, once: in Google Cloud Console enable the Gmail API and the Google Calendar API, then
        under Credentials create an OAuth client ID of type <b className="text-foreground">Desktop app</b> and download its JSON. Paste it here; it stays on this cockpit, readable by you only.
      </p>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder='{"installed": {"client_id": "…", …}}' className="font-code text-ui" aria-label="OAuth client JSON" />
      <Button size="sm" disabled={!text.trim()} loading={save.isPending} onClick={() => save.mutate({ client: text }, { onSuccess: () => setText('') })}>Save client</Button>
      {save.isError && <p className="text-ui text-stopped-ink">{save.error.message}</p>}
    </div>
  );
}

function ConsentSteps({ plugin, slugField, onDone }: { plugin: PluginView; slugField: boolean; onDone: () => void }) {
  const start = useStartGoogleSignIn();
  const finish = useFinishGoogleSignIn();
  const [url, setUrl] = useState<string | null>(null);
  const [redirect, setRedirect] = useState('');
  const [slug, setSlug] = useState('');
  return (
    <div className="space-y-3">
      {slugField && !url && <SlugField plugin={plugin} value={slug} onChange={setSlug} />}
      {!url ? (
        <Button
          size="sm"
          loading={start.isPending}
          onClick={() => start.mutate({ plugin: plugin.id }, {
            onSuccess: (consent) => { setUrl(consent); window.open(consent, '_blank', 'noopener'); },
          })}
        >
          Open Google's sign-in <ExternalLink aria-hidden="true" />
        </Button>
      ) : (
        <>
          <p className="text-ui text-muted-foreground">
            In the tab that opened (<a href={url} target="_blank" rel="noopener noreferrer" className={cn('text-foreground underline underline-offset-2', FOCUS)}>open it again</a>), pick the account and allow every box.
            Google then sends the browser to an address starting with http://127.0.0.1 that may not load — copy that whole address from the address bar and paste it here.
          </p>
          <Input value={redirect} onChange={(e) => setRedirect(e.target.value)} placeholder="http://127.0.0.1:53682/?state=…&code=…" className="font-code text-ui" aria-label="The address the browser ended on" />
          <Button
            size="sm"
            disabled={!redirect.trim().startsWith('http')}
            loading={finish.isPending}
            onClick={() => finish.mutate({ plugin: plugin.id, redirect, slug: slug || undefined }, { onSuccess: onDone })}
          >
            Finish sign-in
          </Button>
        </>
      )}
      {(start.isError || finish.isError) && <p className="text-ui text-stopped-ink">{(start.error ?? finish.error)?.message}</p>}
    </div>
  );
}

/** "Add a Google account": the client if there is none yet, then consent. */
export function GoogleSignIn({ plugin, another }: { plugin: PluginView; another: boolean }) {
  const client = useGoogleClient();
  const [open, setOpen] = useState(false);
  if (!open) {
    return <Button variant="outline" size="sm" className="self-start" onClick={() => setOpen(true)}>{another ? 'Add another Google account' : 'Add a Google account'}</Button>;
  }
  return (
    <div className="space-y-3 border-t border-border pt-3">
      {client.data?.configured === false && <ClientStep fromSignIns={client.data.fromSignIns} />}
      {client.data?.configured === true && <ConsentSteps plugin={plugin} slugField={another} onDone={() => setOpen(false)} />}
      {client.isError && <p className="text-ui text-stopped-ink">{client.error.message}</p>}
      <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
    </div>
  );
}

/** The steps of "Sign in again", for a sign-in Google withdrew or that should get new scopes; full width, under its line. */
export function GoogleSignInAgain({ plugin, connection, onClose }: { plugin: PluginView; connection: ConnectionView; onClose: () => void }) {
  const client = useGoogleClient();
  return (
    <div className="space-y-3 border-t border-border pt-3">
      {client.data?.configured === false && <ClientStep fromSignIns={client.data.fromSignIns} />}
      {client.data?.configured === true && (
        <>
          <p className="text-ui text-muted-foreground">Sign in with {connection.address ?? connection.label} on Google's page.</p>
          <ConsentSteps plugin={plugin} slugField={false} onDone={onClose} />
        </>
      )}
      <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
    </div>
  );
}
