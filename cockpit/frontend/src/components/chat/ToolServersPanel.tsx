// The session's MCP servers: what is there, on/off, reconnect, sign in. Which of
// these a session offers is its runtime's (capabilities.features): a control it
// lacks is not shown. Without a sign-in here it stays in the terminal's /mcp.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, Check, CircleOff, ExternalLink, KeyRound, Loader2, Power, RefreshCw, RotateCcw, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button, Chip, FOCUS, Input } from '@/shared/view/ui';
import Tooltip from '@/shared/view/ui/Tooltip';

import type { ToolServer, ToolServerSignIn } from './chat-state';
import type { ToolServerAction } from './useChatSocket';

// Servers connect in the background, and the host pushes nothing about it.
const PENDING_POLL_MS = 2_000;

const COLUMNS = 'grid grid-cols-(--grid-tool-servers) items-center gap-x-3';

const TRANSPORT: Record<NonNullable<ToolServer['transport']>, string> = { web: 'Web', process: 'Process' };

/** Whether the panel should look again soon: a server is still on its way, or a sign-in is under way. */
export function shouldPoll(servers: ToolServer[] | null, signIns: Record<string, ToolServerSignIn> = {}): boolean {
  return (servers?.some((server) => server.status === 'pending') ?? false) || Object.keys(signIns).length > 0;
}

/** What the panel can do with a server, as the session's runtime offers it. */
export interface ToolServerControls {
  toggle: boolean;
  reconnect: boolean;
  signIn: boolean;
}

/** The line under the list for servers that want a sign-in; null when none does. */
export function signInHint(servers: ToolServer[] | null, can: ToolServerControls): string | null {
  if (!servers?.some((server) => server.status === 'needs-auth')) return null;
  return can.signIn
    ? 'Sign in opens the server\'s own page. The list updates once you are done there.'
    : 'To sign in, switch this pane to the terminal and run /mcp.';
}

function statusOf(server: ToolServer): { label: string; icon: ReactNode } {
  const size = 'size-3.5';
  switch (server.status) {
    case 'connected':
      return { label: `Connected, ${server.toolCount} tools`, icon: <Check className={size} /> };
    case 'pending':
      return { label: 'Connecting', icon: <Loader2 className={cn(size, 'animate-spin text-muted-foreground')} /> };
    case 'needs-auth':
      return { label: 'Needs sign-in', icon: <AlertTriangle className={cn(size, 'text-you-ink')} /> };
    case 'failed':
      return { label: 'Failed', icon: <AlertTriangle className={cn(size, 'text-stopped-ink')} /> };
    case 'disabled':
      return { label: 'Off', icon: <CircleOff className={cn(size, 'text-muted-foreground')} /> };
  }
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip content={label} position="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn('flex min-h-(--target-touch) min-w-(--target-touch) items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:size-(--target-min) md:min-h-0 md:min-w-0', FOCUS)}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * For a sign-in whose page returns to an address on the cockpit's machine: from a browser on another
 * computer that address does not open, and the user pastes it here. Sent once, kept nowhere.
 */
function SignInCode({ name, onFinish }: { name: string; onFinish: (name: string, code: string) => boolean }) {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() && onFinish(name, value.trim())) setValue('');
  };
  const id = `sign-in-code-${name}`;
  return (
    <form onSubmit={submit} className="flex flex-col gap-1 py-1">
      <label htmlFor={id} className="text-muted-foreground">
        Browser on another computer? The page ends on an address that does not open there. Copy it from the address bar and paste it here.
      </label>
      <span className="flex items-center gap-1">
        <Input
          id={id}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="http://localhost:…/callback?code=…"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!value.trim()}>Finish sign-in</Button>
      </span>
    </form>
  );
}

export function ToolServersPanel({ servers, error, signIns, can, onAsk, onChange, onFinishSignIn, onRestart, onClose }: {
  servers: ToolServer[] | null;
  error: string | null;
  /** Sign-ins under way, by server name. */
  signIns: Record<string, ToolServerSignIn>;
  can: ToolServerControls;
  onAsk: () => boolean;
  onChange: (name: string, action: ToolServerAction) => boolean;
  /** What the user pasted back from a sign-in's page. */
  onFinishSignIn: (name: string, code: string) => boolean;
  /** A new process for the session: it reads its servers from the configuration again. */
  onRestart: () => void;
  onClose: () => void;
}) {
  const ask = useRef(onAsk);
  ask.current = onAsk;
  useEffect(() => { ask.current(); }, []);
  const polling = shouldPoll(servers, signIns);
  useEffect(() => {
    if (!polling) return undefined;
    const timer = setInterval(() => ask.current(), PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [polling]);

  const hint = signInHint(servers, can);
  return (
    <div className="max-h-72 overflow-auto rounded-xl border border-border bg-card p-2 text-ui">
      <div className="flex items-center justify-between pb-1">
        <span className="font-semibold">MCP servers</span>
        <span className="flex items-center gap-0.5">
          <IconButton label="Restart session: loads new or changed servers" onClick={onRestart}><RotateCcw aria-hidden className="size-3.5" /></IconButton>
          <IconButton label="Close MCP servers" onClick={onClose}><X aria-hidden className="size-3.5" /></IconButton>
        </span>
      </div>
      {error && <div role="alert" className="pb-1 text-stopped-ink break-words">{error}</div>}
      {servers === null && <div className="text-muted-foreground">Loading…</div>}
      {servers?.length === 0 && !error && <div className="text-muted-foreground">No servers in this session.</div>}
      {servers && servers.length > 0 && (
        <div className={cn(COLUMNS, 'border-b border-border pb-1 text-muted-foreground')}>
          <span>Server</span>
          <span>Type</span>
          <span>Status</span>
        </div>
      )}
      {servers?.map((server) => {
        const status = statusOf(server);
        const off = server.status === 'disabled';
        const signIn = signIns[server.name];
        return (
          <div key={server.name} className="border-b border-border py-0.5 last:border-b-0">
            <div className={COLUMNS}>
              {/* Plain text: names come from configuration. */}
              <span className="truncate" title={server.name}>{server.name}</span>
              <span className="flex items-center gap-1 text-muted-foreground">
                {server.transport ? TRANSPORT[server.transport] : ''}
                {server.scope && <Chip>{server.scope}</Chip>}
              </span>
              <span className="flex items-center gap-0.5">
                <Tooltip content={status.label} position="top">
                  <span role="img" aria-label={status.label} className="flex size-(--target-min) items-center justify-center">{status.icon}</span>
                </Tooltip>
                {can.signIn && server.status === 'needs-auth' && !signIn && (
                  <IconButton label={`Sign in to ${server.name}`} onClick={() => onChange(server.name, 'sign_in')}>
                    <KeyRound aria-hidden className="size-3.5" />
                  </IconButton>
                )}
                {!off && can.reconnect && (
                  <IconButton label={`Reconnect ${server.name}`} onClick={() => onChange(server.name, 'reconnect')}>
                    <RefreshCw aria-hidden className="size-3.5" />
                  </IconButton>
                )}
                {can.toggle && (
                  <IconButton label={`Turn ${server.name} ${off ? 'on' : 'off'} (all sessions in this project)`} onClick={() => onChange(server.name, off ? 'enable' : 'disable')}>
                    <Power aria-hidden className="size-3.5" />
                  </IconButton>
                )}
              </span>
            </div>
            {server.error && <div className="text-stopped-ink break-words">{server.error}</div>}
            {signIn && (
              <a
                href={signIn.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn('inline-flex items-center gap-1 py-0.5 text-foreground underline underline-offset-2', FOCUS)}
              >
                Open the sign-in page for {server.name}
                <ExternalLink aria-hidden className="size-3" />
              </a>
            )}
            {signIn?.takesCode && <SignInCode name={server.name} onFinish={onFinishSignIn} />}
          </div>
        );
      })}
      {hint && <div className="pt-1 text-muted-foreground">{hint}</div>}
    </div>
  );
}
