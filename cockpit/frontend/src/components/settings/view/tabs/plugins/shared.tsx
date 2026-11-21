// Small pieces Settings › Plugins shares between its views.
import { Mail, Plug, Puzzle, type LucideIcon } from 'lucide-react';

import { PANE_VIEW_DEFS } from '@/lib/pane-views';
import type { PluginPart, PluginTier, PluginView } from '@/lib/plugins-admin';
import { cn } from '@/lib/utils';
import { Chip } from '@/shared/view/ui';

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
