// A subagent in the conversation: what it was asked, what it is doing, the tools
// it called, and its report. Without live task data (a stored conversation) the
// card shows what the transcript has: the call and its result.
import { AlertCircle, Check, ChevronRight, CircleSlash, Loader2, Users } from 'lucide-react';

import { formatTokens } from '@/components/main-content/view/subcomponents/TerminalStatusBar';
import { cn } from '@/lib/utils';

import type { AgentTask, AgentTool, ChatItem } from './chat-state';
import { TARGET, TOOL_ICONS } from './tool-icons';

type ToolItem = Extract<ChatItem, { type: 'tool' }>;
type CardStatus = 'running' | 'background' | 'completed' | 'failed' | 'stopped';

function cardStatus(tool: ToolItem, agent: AgentTask | null): CardStatus {
  if (agent) {
    if (agent.status !== 'running') return agent.status;
    return agent.background ? 'background' : 'running';
  }
  if (tool.status === 'running') return 'running';
  if (tool.status === 'failed') return 'failed';
  if (tool.status === 'interrupted') return 'stopped';
  return tool.status === 'launched' ? 'background' : 'completed';
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function StatusMark({ status }: { status: CardStatus }) {
  if (status === 'running' || status === 'background') return <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" aria-label="Running" />;
  if (status === 'failed') return <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-destructive" aria-label="Failed" />;
  if (status === 'stopped') return <CircleSlash className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-label="Stopped" />;
  return <Check className="h-3.5 w-3.5 flex-shrink-0 text-success" aria-label="Done" />;
}

export function AgentCard({
  tool, agent, tools, opened, onToggle, onStop,
}: {
  tool: ToolItem;
  agent: AgentTask | null;
  tools: AgentTool[];
  opened: boolean;
  onToggle: (id: string) => void;
  onStop: (taskId: string) => void;
}) {
  const status = cardStatus(tool, agent);
  const live = status === 'running' || status === 'background';
  const open = opened || status === 'failed';
  const facts = [
    status === 'background' ? 'in background' : null,
    agent?.toolUses != null ? `${agent.toolUses} ${agent.toolUses === 1 ? 'tool' : 'tools'}` : null,
    agent?.tokens != null ? `${formatTokens(agent.tokens)} tokens` : null,
    agent?.durationMs != null ? formatDuration(agent.durationMs) : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-start gap-1 p-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(tool.id)}
          className={cn('flex min-w-0 flex-1 items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-foreground/5', TARGET)}
        >
          <ChevronRight className={cn('mt-1 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} strokeWidth={1.8} />
          <Users className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" strokeWidth={1.8} />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{agent?.description ?? tool.title}</span>
            {/* Plain text: agent names come from configuration. */}
            {(agent?.agentType || facts) && (
              <span className="block truncate text-muted-foreground">
                {[agent?.agentType, facts].filter(Boolean).join(' · ')}
              </span>
            )}
            {live && agent?.activity && <span className="block truncate text-muted-foreground">{agent.activity}</span>}
          </span>
          <StatusMark status={status} />
        </button>
        {live && agent && (
          <button
            type="button"
            onClick={() => onStop(agent.taskId)}
            className={cn('flex-shrink-0 rounded px-2 py-1 text-muted-foreground hover:bg-foreground/5', TARGET)}
          >
            Stop
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-1.5 border-t border-border p-2">
          {tools.map((inner) => {
            const Icon = TOOL_ICONS[inner.toolKind];
            return (
              <div key={inner.id} className="flex items-center gap-2 text-muted-foreground">
                <Icon className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.8} />
                <span className="min-w-0 flex-1 truncate font-mono">{inner.title}</span>
                {inner.status === 'running' && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" aria-label="Running" />}
                {inner.status === 'failed' && <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-destructive" aria-label="Failed" />}
              </div>
            );
          })}
          {tool.output && (
            <pre className="max-h-72 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap break-words text-foreground">{tool.output}</pre>
          )}
          {!tool.output && tools.length === 0 && <div className="text-muted-foreground">{live ? 'Starting…' : 'No output'}</div>}
        </div>
      )}
    </div>
  );
}
