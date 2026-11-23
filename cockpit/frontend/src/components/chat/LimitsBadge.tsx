// A session's limits as a badge after the pane's title: "Limited" while the job or session that
// started it turned tools off. Its menu says what is off, in readable names, and lets the user
// allow them with a restart; no agent can.
import { Ban, ChevronDown, Lock } from 'lucide-react';

import { Menu, type MenuItem } from '@/shared/view/ui';

import { useChatSession, type SessionLimits } from './chat-store';
import { toolLabel } from './tool-label';
import { liftLimits } from './useChatSocket';

/** The session has limits to show. */
export function isLimited(limits: SessionLimits | null): limits is SessionLimits {
  return !!limits && (limits.deniedTools.length > 0 || limits.mcpServers !== null);
}

/** What the badge's button is called: the badge's word, then how much is off. */
export function limitsName(limits: SessionLimits): string {
  const tools = limits.deniedTools.length;
  return tools ? `Limited: ${tools} ${tools === 1 ? 'tool' : 'tools'} off` : 'Limited: some MCP servers only';
}

/** The menu's actions: this session only, and with a job its future runs too; none when the limits can't be lifted here. */
export function limitsActions(limits: SessionLimits, lift: (forJob: boolean) => void): MenuItem[] {
  if (!limits.liftable) return [];
  return [
    { label: 'Allow in this session', onSelect: () => lift(false) },
    ...(limits.job ? [{ label: 'Allow in this session and future runs', onSelect: () => lift(true) }] : []),
  ];
}

export function LimitsBadge({ sessionId }: { sessionId: string }) {
  const { limits, chat } = useChatSession(sessionId);
  if (!isLimited(limits)) return null;
  const running = chat.activity !== 'idle';
  return (
    <Menu
      label={limitsName(limits)}
      align="start"
      items={limitsActions(limits, (forJob) => liftLimits(sessionId, forJob))}
      className="flex size-auto h-6 items-center gap-1 rounded-full bg-muted px-2 text-caption font-medium text-foreground"
      header={(
        <div className="px-2 pt-1.5 pb-1 text-ui">
          {/* Plain text: tool, server and job names come from configuration. */}
          <p className="pb-1 text-muted-foreground">{limits.job ? 'This job session can\'t use:' : 'This session can\'t use:'}</p>
          <ul className="flex flex-col gap-1">
            {limits.deniedTools.map((tool) => (
              <li key={tool} className="flex items-center gap-1.5">
                <Ban aria-hidden className="size-3.5 flex-shrink-0 text-muted-foreground" />
                {toolLabel(tool)}
              </li>
            ))}
            {limits.mcpServers !== null && (
              <li className="flex items-center gap-1.5">
                <Ban aria-hidden className="size-3.5 flex-shrink-0 text-muted-foreground" />
                MCP servers other than {limits.mcpServers.length ? limits.mcpServers.join(', ') : 'the brain'}
              </li>
            )}
          </ul>
          <div aria-hidden className="mt-2 h-px bg-border" />
        </div>
      )}
      footer={(
        <p className="px-2 pt-1 pb-1.5 text-caption text-muted-foreground">
          {limits.liftable
            ? `The session restarts; the conversation stays.${running ? ' The running turn stops.' : ''}`
            : 'This job answers messages from outside. Lend it tools in the Jobs view.'}
        </p>
      )}
    >
      <Lock aria-hidden className="size-3" strokeWidth={2} />
      Limited
      <ChevronDown aria-hidden className="size-3" strokeWidth={2} />
    </Menu>
  );
}
