// The session's MCP servers: what is there, on/off, reconnect. Signing in stays
// in the terminal's /mcp: the SDK has no call for it.
import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, Check, CircleOff, Loader2, Power, RefreshCw, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Chip, FOCUS } from '@/shared/view/ui';
import Tooltip from '@/shared/view/ui/Tooltip';

import type { ToolServer } from './chat-state';
import type { ToolServerAction } from './useChatSocket';

// Servers connect in the background, and the host pushes nothing about it.
const PENDING_POLL_MS = 2_000;

const COLUMNS = 'grid grid-cols-(--grid-tool-servers) items-center gap-x-3';

const TRANSPORT: Record<NonNullable<ToolServer['transport']>, string> = { web: 'Web', process: 'Process' };

/** Whether the panel should look again soon: a server is still on its way. */
export function shouldPoll(servers: ToolServer[] | null): boolean {
  return servers?.some((server) => server.status === 'pending') ?? false;
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

export function ToolServersPanel({ servers, error, onAsk, onChange, onClose }: {
  servers: ToolServer[] | null;
  error: string | null;
  onAsk: () => boolean;
  onChange: (name: string, action: ToolServerAction) => boolean;
  onClose: () => void;
}) {
  const ask = useRef(onAsk);
  ask.current = onAsk;
  useEffect(() => { ask.current(); }, []);
  const polling = shouldPoll(servers);
  useEffect(() => {
    if (!polling) return undefined;
    const timer = setInterval(() => ask.current(), PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [polling]);

  const needsSignIn = servers?.some((server) => server.status === 'needs-auth');
  return (
    <div data-ui="v2" className="max-h-72 overflow-auto rounded-xl border border-border bg-card p-2 text-ui">
      <div className="flex items-center justify-between pb-1">
        <span className="font-semibold">MCP servers</span>
        <IconButton label="Close MCP servers" onClick={onClose}><X aria-hidden className="size-3.5" /></IconButton>
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
                {!off && (
                  <IconButton label={`Reconnect ${server.name}`} onClick={() => onChange(server.name, 'reconnect')}>
                    <RefreshCw aria-hidden className="size-3.5" />
                  </IconButton>
                )}
                <IconButton label={`Turn ${server.name} ${off ? 'on' : 'off'} (all sessions in this project)`} onClick={() => onChange(server.name, off ? 'enable' : 'disable')}>
                  <Power aria-hidden className="size-3.5" />
                </IconButton>
              </span>
            </div>
            {server.error && <div className="text-stopped-ink break-words">{server.error}</div>}
          </div>
        );
      })}
      {needsSignIn && <div className="pt-1 text-muted-foreground">To sign in, switch this pane to the terminal and run /mcp.</div>}
    </div>
  );
}
