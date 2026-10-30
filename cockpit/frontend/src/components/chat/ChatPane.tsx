// The chat view of a session: conversation, tool rows, permission and question
// cards, input. Everything it shows comes from the session's event log.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import {
  AlertCircle, ArrowDown, Brain, ChevronRight, Loader2,
} from 'lucide-react';

import TerminalStatusBar from '@/components/main-content/view/subcomponents/TerminalStatusBar';
import { cn } from '@/lib/utils';
import type { ProjectSession } from '@/types/app';

import { AgentCard } from './AgentCard';
import { groupItems, statusLine, type AgentTask, type AgentTool, type FoldedItem, type ChatItem, type Question, type RequestOutcome } from './chat-state';
import { useChatSession } from './chat-store';
import { Composer, ModelPicker } from './Composer';
import { TARGET, TOOL_ICONS } from './tool-icons';
import { ToolServersPanel } from './ToolServersPanel';
import { useChatSocket, type PermissionReply } from './useChatSocket';

type ToolItem = Extract<ChatItem, { type: 'tool' }>;
type PermissionItem = Extract<ChatItem, { type: 'permission' }>;
type QuestionItem = Extract<ChatItem, { type: 'question' }>;

const COLUMN = 'w-full px-3 md:px-4';

const OUTCOME_LABEL: Record<RequestOutcome, string> = {
  allowed: 'Allowed once',
  always: 'Always allowed',
  denied: 'Denied',
  answered: 'Answered',
  cancelled: 'No longer asked',
};

const Assistant = memo(function Assistant({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="min-w-0 break-words text-foreground">
      <Streamdown mode={streaming ? 'streaming' : 'static'} isAnimating={streaming}>{text}</Streamdown>
    </div>
  );
});

function ToolStatusMark({ tool }: { tool: ToolItem }) {
  if (tool.status === 'running') return <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" aria-label="Running" />;
  if (tool.status === 'failed') return <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-destructive" aria-label="Failed" />;
  if (tool.status === 'launched') return <span className="flex-shrink-0 text-muted-foreground">in background</span>;
  if (tool.status === 'interrupted') return <span className="flex-shrink-0 text-muted-foreground">stopped</span>;
  return null;
}

/** Open rows stay open across new events: `opened` lives in the pane. */
function ToolRow({ tool, opened, onToggle }: { tool: ToolItem; opened: boolean; onToggle: (id: string) => void }) {
  const Icon = TOOL_ICONS[tool.toolKind];
  const open = opened;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(tool.id)}
        className={cn('flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-muted-foreground hover:bg-foreground/5', TARGET)}
      >
        <Icon className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate font-mono">{tool.title}</span>
        <ToolStatusMark tool={tool} />
      </button>
      {open && (
        <>
          {tool.approval && <div className="px-1 pt-0.5 text-muted-foreground">{OUTCOME_LABEL[tool.approval]}</div>}
          <pre className="mt-1 mb-1 max-h-72 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap break-words text-foreground">
            {tool.output || (tool.status === 'running' ? 'Running…' : 'No output')}
          </pre>
        </>
      )}
    </div>
  );
}

function ThinkingRow({ item, opened, onToggle }: { item: Extract<FoldedItem, { type: 'thinking' }>; opened: boolean; onToggle: (id: string) => void }) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={opened}
        onClick={() => onToggle(item.id)}
        className={cn('flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-muted-foreground hover:bg-foreground/5', TARGET)}
      >
        <Brain className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate">{item.streaming ? 'Thinking…' : 'Thinking'}</span>
      </button>
      {opened && <div className="px-1 pt-0.5 pb-1 whitespace-pre-wrap break-words text-muted-foreground">{item.text}</div>}
    </div>
  );
}

function FoldedRow({ item, opened, onToggle }: { item: FoldedItem; opened: Set<string>; onToggle: (id: string) => void }) {
  return item.type === 'thinking'
    ? <ThinkingRow item={item} opened={opened.has(item.id)} onToggle={onToggle} />
    : <ToolRow tool={item} opened={opened.has(item.id)} onToggle={onToggle} />;
}

/** One line for a run: what is in it, and whether something runs or failed. */
function foldLabel(items: FoldedItem[]): string {
  const calls = items.filter((item) => item.type === 'tool').length;
  const thinking = calls < items.length ? 'Thinking' : '';
  const toolCalls = calls === 0 ? '' : `${calls} tool ${calls === 1 ? 'call' : 'calls'}`;
  return [thinking, toolCalls].filter(Boolean).join(', ');
}

function ToolGroup({ tools, id, opened, onToggle }: { tools: FoldedItem[]; id: string; opened: Set<string>; onToggle: (id: string) => void }) {
  if (tools.length === 1) return <FoldedRow item={tools[0]} opened={opened} onToggle={onToggle} />;
  const groupKey = `group:${id}`;
  const open = opened.has(groupKey);
  const running = tools.some((item) => (item.type === 'tool' ? item.status === 'running' : item.streaming));
  const failed = tools.some((item) => item.type === 'tool' && item.status === 'failed');
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(groupKey)}
        className={cn('flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-muted-foreground hover:bg-foreground/5', TARGET)}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 flex-shrink-0 transition-transform', open && 'rotate-90')} strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate">{foldLabel(tools)}</span>
        {failed && <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-destructive" aria-label="A call failed" />}
        {running && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" aria-label="Running" />}
      </button>
      {open && (
        <div className="ml-3 border-l border-border pl-2">
          {tools.map((item) => <FoldedRow key={item.id} item={item} opened={opened} onToggle={onToggle} />)}
        </div>
      )}
    </div>
  );
}

/** The exact thing being approved: the command, or the path with the change. */
function PermissionPreview({ item }: { item: PermissionItem }) {
  const { input } = item;
  const path = typeof input.file_path === 'string' ? input.file_path : null;
  const code = 'max-h-72 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-words';
  if (typeof input.command === 'string') return <pre className={code}>{input.command}</pre>;
  if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
    return (
      <div className="space-y-1">
        {path && <div className="font-mono break-all">{path}</div>}
        <pre className={code}>
          {String(input.old_string ?? '').split('\n').map((line, i) => <div key={`o${i}`} className="text-destructive">- {line}</div>)}
          {String(input.new_string ?? '').split('\n').map((line, i) => <div key={`n${i}`} className="text-success">+ {line}</div>)}
        </pre>
      </div>
    );
  }
  if (typeof input.content === 'string') {
    return (
      <div className="space-y-1">
        {path && <div className="font-mono break-all">{path}</div>}
        <pre className={code}>{input.content}</pre>
      </div>
    );
  }
  return <pre className={code}>{JSON.stringify(input, null, 2)}</pre>;
}

function SettledRow({ label, outcome }: { label: string; outcome: RequestOutcome }) {
  return <div className="px-1 text-muted-foreground">{OUTCOME_LABEL[outcome]}: <span className="font-mono">{label}</span></div>;
}

function PermissionCard({ item, onAnswer }: { item: PermissionItem; onAnswer: (id: string, reply: PermissionReply) => void }) {
  if (item.outcome) return <SettledRow label={item.title} outcome={item.outcome} />;
  const button = cn('rounded-md border border-border px-3 py-1.5 hover:bg-foreground/5', TARGET);
  return (
    <div className="space-y-2 rounded-md border border-warning/50 bg-card p-3">
      {/* Plain text: tool and server names come from configuration. */}
      <div className="font-medium break-words">{item.title}</div>
      {item.reason && <div className="text-muted-foreground">{item.reason}</div>}
      <PermissionPreview item={item} />
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap">
        <button type="button" className={button} onClick={() => onAnswer(item.id, { decision: 'allow' })}>Allow once</button>
        {item.alwaysScope && (
          <button type="button" className={button} title={item.alwaysScope} onClick={() => onAnswer(item.id, { decision: 'always' })}>Always</button>
        )}
        <button type="button" className={button} onClick={() => onAnswer(item.id, { decision: 'deny' })}>Deny</button>
      </div>
      {item.alwaysScope && <div className="text-muted-foreground">Always: {item.alwaysScope}</div>}
    </div>
  );
}

function QuestionBlock({ question, chosen, onChange }: { question: Question; chosen: string; onChange: (value: string) => void }) {
  const picked = question.multiSelect ? chosen.split(', ').filter(Boolean) : [chosen];
  const toggle = (label: string) => {
    if (!question.multiSelect) { onChange(label); return; }
    onChange((picked.includes(label) ? picked.filter((p) => p !== label) : [...picked, label]).join(', '));
  };
  return (
    <div className="space-y-1.5">
      <div className="font-medium break-words">{question.question}</div>
      <div className="flex flex-col gap-1.5">
        {question.options.map((option) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={picked.includes(option.label)}
            onClick={() => toggle(option.label)}
            className={cn(
              'rounded-md border border-border px-3 py-1.5 text-left hover:bg-foreground/5', TARGET,
              picked.includes(option.label) && 'border-primary bg-foreground/5',
            )}
          >
            {option.label}
            {option.description && <span className="block text-muted-foreground">{option.description}</span>}
          </button>
        ))}
      </div>
      <input
        type="text"
        aria-label="Your own answer"
        placeholder="Or your own answer"
        value={question.options.some((option) => picked.includes(option.label)) ? '' : chosen}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5"
      />
    </div>
  );
}

function QuestionCard({ item, onAnswer }: { item: QuestionItem; onAnswer: (id: string, reply: PermissionReply) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (item.outcome) return <SettledRow label={item.questions[0]?.question ?? 'Question'} outcome={item.outcome} />;
  const complete = item.questions.every((question) => answers[question.question]?.trim());
  return (
    <div className="space-y-3 rounded-md border border-warning/50 bg-card p-3">
      {item.questions.map((question) => (
        <QuestionBlock
          key={question.question}
          question={question}
          chosen={answers[question.question] ?? ''}
          onChange={(value) => setAnswers((prev) => ({ ...prev, [question.question]: value }))}
        />
      ))}
      <div className="flex flex-col gap-2 md:flex-row">
        <button
          type="button"
          disabled={!complete}
          onClick={() => onAnswer(item.id, { decision: 'answer', answers })}
          className={cn('rounded-md border border-border px-3 py-1.5 hover:bg-foreground/5 disabled:opacity-50', TARGET)}
        >
          Answer
        </button>
        <button
          type="button"
          onClick={() => onAnswer(item.id, { decision: 'deny' })}
          className={cn('rounded-md border border-border px-3 py-1.5 hover:bg-foreground/5', TARGET)}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function JumpToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      type="button"
      onClick={() => { void scrollToBottom(); }}
      className={cn('absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card px-3 py-1 shadow', TARGET)}
    >
      <ArrowDown className="h-3 w-3" /> Jump to latest
    </button>
  );
}

/** Lets the input re-pin the scroll when a message goes out. */
function PinOnSend({ pinRef }: { pinRef: React.MutableRefObject<(() => void) | null> }) {
  const { scrollToBottom } = useStickToBottomContext();
  useEffect(() => {
    pinRef.current = () => { void scrollToBottom(); };
    return () => { pinRef.current = null; };
  }, [pinRef, scrollToBottom]);
  return null;
}

const Messages = memo(function Messages({
  items, agents, agentTools, onAnswer, onStopAgent,
}: {
  items: ChatItem[];
  agents: AgentTask[];
  agentTools: Record<string, AgentTool[]>;
  onAnswer: (id: string, reply: PermissionReply) => void;
  onStopAgent: (taskId: string) => void;
}) {
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const groups = useMemo(() => groupItems(items), [items]);
  return (
    <div role="log" aria-live="off" className={cn(COLUMN, 'space-y-4 py-4')}>
      {groups.map((group) => {
        if (group.kind === 'agent') {
          const { tool } = group;
          return (
            <AgentCard
              key={tool.id}
              tool={tool}
              agent={agents.find((agent) => agent.toolId === tool.id) ?? null}
              tools={agentTools[tool.id] ?? []}
              opened={opened.has(tool.id)}
              onToggle={toggle}
              onStop={onStopAgent}
            />
          );
        }
        if (group.kind === 'tools') return <ToolGroup key={group.id} id={group.id} tools={group.tools} opened={opened} onToggle={toggle} />;
        const { item } = group;
        switch (item.type) {
          case 'user':
            return (
              <div key={item.id} className="flex flex-col items-end gap-1 pt-2">
                <div className="max-w-[min(85%,528px)] rounded-md bg-muted px-3 py-1.5 whitespace-pre-wrap break-words">{item.text}</div>
                {item.queued && <span className="text-muted-foreground">queued</span>}
              </div>
            );
          case 'assistant':
            return <Assistant key={item.id} text={item.text} streaming={item.streaming} />;
          case 'permission':
            return <PermissionCard key={item.id} item={item} onAnswer={onAnswer} />;
          case 'question':
            return <QuestionCard key={item.id} item={item} onAnswer={onAnswer} />;
          case 'notice':
            return <div key={item.id} className="px-1 text-muted-foreground">{item.text}</div>;
          case 'error':
            return <div key={item.id} role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-destructive break-words">{item.text}</div>;
          case 'interrupted':
            return <div key={item.id} className="px-1 text-muted-foreground">Stopped.</div>;
          default:
            return null;
        }
      })}
    </div>
  );
});

export function ChatPane({
  paneId, projectId, sessionId, session,
}: { paneId: string; projectId: string; sessionId: string; session: ProjectSession | null }) {
  const { chat, connection, switching, problem, toolServers, toolServersError } = useChatSession(sessionId);
  const { send, interrupt, answer, setMode, setModel, stopAgent, reconnect, askToolServers, changeToolServer } = useChatSocket(paneId, projectId, sessionId);
  const pinRef = useRef<(() => void) | null>(null);
  const [serversOpen, setServersOpen] = useState(false);
  const running = chat.activity !== 'idle';
  const status = switching
    ?? (connection === 'closed' ? 'Connection lost, reconnecting…' : connection === 'connecting' ? 'Connecting…' : statusLine(chat));

  const onSend = useCallback((text: string) => {
    if (text.trim() === '/mcp') { setServersOpen(true); return true; }
    const sent = send(text);
    if (sent) pinRef.current?.();
    return sent;
  }, [send]);

  return (
    <div className="chat-pane flex h-full min-h-0 flex-col">
      <StickToBottom className="relative min-h-0 flex-1 overflow-hidden" resize="smooth" initial="instant">
        <StickToBottom.Content>
          <Messages items={chat.items} agents={chat.agents} agentTools={chat.agentTools} onAnswer={answer} onStopAgent={stopAgent} />
        </StickToBottom.Content>
        <JumpToLatest />
        <PinOnSend pinRef={pinRef} />
      </StickToBottom>
      <div className={cn(COLUMN, 'flex-shrink-0 space-y-2 pb-2')}>
        {problem && <div role="alert" className="text-destructive break-words">{problem}</div>}
        {connection === 'superseded' && (
          <div className="flex items-center gap-2 text-muted-foreground">
            This session moved to another view.
            <button type="button" onClick={reconnect} className={cn('underline', TARGET)}>Bring it back here</button>
          </div>
        )}
        {serversOpen && (
          <ToolServersPanel
            servers={toolServers}
            error={toolServersError}
            onAsk={askToolServers}
            onChange={changeToolServer}
            onClose={() => setServersOpen(false)}
          />
        )}
        <div role="status" className="min-h-4 text-muted-foreground">{status}</div>
        <Composer
          sessionId={sessionId}
          running={running}
          chat={chat}
          onSend={onSend}
          onStop={interrupt}
          onSetMode={setMode}
          onStopAgent={stopAgent}
        />
        <TerminalStatusBar
          session={session}
          live={{ model: chat.model, contextTokens: chat.context?.usedTokens ?? null, contextWindow: chat.context?.maxTokens ?? null }}
          modelSlot={<ModelPicker chat={chat} onSetModel={setModel} />}
          className="border-t-0 px-1 pt-0.5 text-muted-foreground"
        />
      </div>
    </div>
  );
}
