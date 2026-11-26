// Small pieces Settings › Plugins shares between its views.
import { Mail, Plug, Puzzle, type LucideIcon } from 'lucide-react';

import { PANE_VIEW_DEFS } from '@/lib/pane-views';
import type { ConnectionView, PluginPart, PluginTier, PluginView } from '@/lib/plugins-admin';
import { formatAgo } from '@/lib/time';
import { formatWhen } from '@/lib/time-zone';
import { cn } from '@/lib/utils';
import { Chip, Input } from '@/shared/view/ui';

export const TIER_LABEL: Record<PluginTier, string> = { official: 'Official', custom: 'Custom MCP', community: 'Community', dev: 'Local dev' };

export const PART_LABEL: Record<PluginPart, string> = { pane: 'Pane', mcp: 'Tools (MCP)', channel: 'Channel' };

/** A built-in pane's own icon; a channel a letter; a server a plug. */
export function pluginIcon(plugin: PluginView): LucideIcon {
  const pane = PANE_VIEW_DEFS.find((def) => def.view === plugin.pane);
  if (pane) return pane.icon;
  if (plugin.channel) return Mail;
  return plugin.mcp ? Plug : Puzzle;
}

export function PluginIcon({ plugin, large }: { plugin: PluginView; large?: boolean }) {
  const Icon = pluginIcon(plugin);
  return (
    <span className={cn('grid shrink-0 place-items-center rounded-lg bg-muted text-foreground', large ? 'size-11' : 'size-8')}>
      <Icon className={large ? 'size-5' : 'size-4'} aria-hidden="true" />
    </span>
  );
}

export function TierChip({ tier }: { tier: PluginTier }) {
  return <Chip className={cn('py-0.5', tier === 'community' && 'border border-dashed border-border-strong bg-transparent', tier === 'official' && 'text-foreground')}>{tier === 'official' ? `✓ ${TIER_LABEL[tier]}` : TIER_LABEL[tier]}</Chip>;
}

export function PartChips({ plugin }: { plugin: PluginView }) {
  return (
    <>
      {plugin.parts.map((part) => <Chip key={part} className={cn('py-0.5 font-code', plugin.partsOff.includes(part) ? 'line-through' : 'text-foreground')}>{part}</Chip>)}
    </>
  );
}

/** What a tier may do, in the words the detail page uses (decision cockpit-plugin-isolation). */
export function trustNote(tier: PluginTier): string {
  switch (tier) {
    case 'official': return 'Ships with the cockpit, reviewed and pinned with it. Server parts run as their own process with only this plugin\'s secrets.';
    case 'custom': return 'Added by you. Its server runs with your user rights, as its own process with only its own secrets.';
    case 'community': return 'Unverified. It runs as a sandboxed pane only and can add no tools or channels.';
    case 'dev': return 'Local dev mode: every part runs, unchecked.';
  }
}

/** It needs one of the user's sign-ins to work: a sign-in kind, or a secret setting. */
/** A remote MCP server that signs in with OAuth, or one without secrets that may (its first sign-in says so). */
export function signsInWithOAuth(plugin: PluginView): boolean {
  if (plugin.auth?.kind === 'mcp-oauth') return true;
  return !plugin.auth && !!plugin.mcp && plugin.mcp.transport !== 'stdio' && !plugin.mcp.settings.some((s) => s.secret);
}

export function needsSignIn(plugin: PluginView): boolean {
  return !!plugin.auth || !!plugin.mcp?.settings.some((s) => s.secret);
}

/** The short name a second sign-in gives its MCP server (gmail-invoice); empty: the plugin's own name. */
export function SlugField({ plugin, value, onChange }: { plugin: PluginView; value: string; onChange: (slug: string) => void }) {
  return (
    <label className="block text-body">
      <span className="text-muted-foreground">Short name (optional)</span>
      <Input value={value} onChange={(e) => onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="invoice" className="mt-1 font-code text-ui" />
      <span className="text-ui text-muted-foreground">Its tools: mcp__{plugin.id}{value ? `-${value}` : ''}__… — give each further sign-in in a space a name of its own.</span>
    </label>
  );
}

/** How a sign-in's line reads, and whether it asks the user to act. */
export interface SignInNote {
  text: string;
  /** `act`: the user has to do something (sign in again, a new key, pick it in a space). */
  tone: 'quiet' | 'act';
}

/**
 * What a sign-in can do now, in one line: never just "Connected". A good token says until when, a
 * key how old it is, and a sign-in no space uses says so, since sessions would not reach it.
 */
export function signInNote(plugin: PluginView, connection: ConnectionView, spaceNames: (id: string) => string): SignInNote {
  const tools = plugin.mcp ? ` · its tools: ${plugin.id}${connection.slug ? `-${connection.slug}` : ''}` : '';
  const used = connection.usedAt ? ` · last used ${formatAgo(connection.usedAt)}` : '';
  const spaces = connection.spaces ?? null;
  const inSpaces = spaces === null ? '' : spaces.length > 0 ? ` · in ${spaces.map(spaceNames).join(', ')}` : '';
  if (connection.health === 'refused' || connection.signInNeeded) {
    return { text: 'The server refused to renew this sign-in: sign in again. Sessions using it get no answer until then.', tone: 'act' };
  }
  if (spaces !== null && spaces.length === 0 && plugin.mcp) {
    return { text: 'Signed in, but no space uses it: pick it for a space below, else sessions don\'t get these tools.', tone: 'act' };
  }
  if (connection.health === 'old') {
    const age = connection.savedAt ? `saved ${formatAgo(connection.savedAt)}` : 'of unknown age';
    return { text: `Key ${age}: replace it with a new one from the service, then remove this one${inSpaces}`, tone: 'act' };
  }
  if (connection.oauth) {
    const until = connection.health === 'renewing'
      ? 'Token ran out, renewed at the next use'
      : connection.expiresAt ? `Valid until ${formatWhen(connection.expiresAt)}` : 'Signed in';
    return { text: `${until}${tools} · renewed by the cockpit${inSpaces}${used}`, tone: 'quiet' };
  }
  const saved = connection.savedAt ? ` · saved ${formatAgo(connection.savedAt)}` : '';
  return { text: `Key stored${saved}${tools}${connection.relayed ? ' · sessions reach it through the cockpit' : ''}${inSpaces}${used}, owner only, never shown`, tone: 'quiet' };
}
