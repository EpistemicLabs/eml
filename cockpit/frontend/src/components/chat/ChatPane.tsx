// The chat view of a session: conversation, tool rows, permission and question
// cards, input. Everything it shows comes from the session's event log.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import {
  AlertCircle, ArrowDown, Brain, ChevronRight, Copy, Image as ImageIcon, Loader2,
} from 'lucide-react';

import TerminalStatusBar from '@/components/main-content/view/subcomponents/TerminalStatusBar';
import { useCompactLayout } from '@/hooks/useCompactLayout';
import { returnToReviewBar } from '@/stores/useReviewStore';
import { cn } from '@/lib/utils';
import { buttonVariants, Chip, FIELD, FOCUS } from '@/shared/view/ui';
import type { ProjectSession } from '@/types/app';
import { copyTextToClipboard } from '@/utils/clipboard';

import { AgentCard } from './AgentCard';
import { latestUserMessageId, wasAtBottom, editDiff, foldSummary, groupItems, keysToReveal, outputPreview, type DiffLine, latestToolId, statusLine, type AgentTask, type AgentTool, type FoldedItem, type ChatItem, type Question, type RequestOutcome } from './chat-state';
import { useChatSession } from './chat-store';
import { Composer, ModelPicker } from './Composer';
import { TARGET, TOOL_ICONS } from './tool-icons';
import { ToolServersPanel } from './ToolServersPanel';
import { ChatSearch } from './ChatSearch';
import { replyRehypePlugins } from './reply-markdown';
import { useChatShortcuts } from './useChatShortcuts';
import { useChatSocket, type PermissionReply } from './useChatSocket';

type ToolItem = Extract<ChatItem, { type: 'tool' }>;
type PermissionItem = Extract<ChatItem, { type: 'permission' }>;
type QuestionItem = Extract<ChatItem, { type: 'question' }>;

// Centered, as wide as one of two panes side by side on a large screen.
const COLUMN = 'mx-auto w-full max-w-(--size-chat-column) px-3 md:px-4';
/** A secondary action in a card: outline, the touch size on a phone. */
const CARD_BUTTON = cn(buttonVariants({ variant: 'outline' }), 'max-md:min-h-(--target-touch)');

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
      <Streamdown mode={streaming ? 'streaming' : 'static'} isAnimating={streaming} rehypePlugins={replyRehypePlugins}>{text}</Streamdown>
    </div>
  );
});

function ToolStatusMark({ tool }: { tool: ToolItem }) {
  if (tool.status === 'running') return <Loader2 className="size-3.5 flex-shrink-0 animate-spin text-muted-foreground" aria-label="Running" />;
  if (tool.status === 'failed') return <AlertCircle className="size-3.5 flex-shrink-0 text-stopped-ink" aria-label="Failed" />;
  if (tool.status === 'launched') return <span className="flex-shrink-0 text-muted-foreground">in background</span>;
  if (tool.status === 'interrupted') return <span className="flex-shrink-0 text-muted-foreground">stopped</span>;
  return null;
}

function DiffBlock({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="mt-1 mb-1 max-h-72 overflow-auto rounded bg-muted p-2 pr-8 font-code whitespace-pre-wrap break-words text-foreground">
      {lines.map((line, index) => (
        // A diff doesn't reorder, and its lines may repeat.
        <div key={index} className={line.sign === '+' ? 'text-(--diff-added)' : line.sign === '-' ? 'text-(--diff-removed)' : undefined}>{line.sign} {line.text}</div>
      ))}
    </pre>
  );
}

/** A few lines of a command's output, in place; the row or the count opens all of it. */
function OutputPreview({ output, onOpen }: { output: string; onOpen: () => void }) {
  const { head, hidden, tail } = outputPreview(output);
  const block = 'whitespace-pre-wrap break-words';
  return (
    <div className="mt-0.5 ml-(--indent-chat-work) border-l border-border pl-3 font-code text-muted-foreground">
      <div className={block}>{head.join('\n')}</div>
      {hidden > 0 && <button type="button" onClick={onOpen} className={cn('rounded hover:text-foreground', FOCUS, TARGET)}>… +{hidden} lines</button>}
      {tail.length > 0 && <div className={block}>{tail.join('\n')}</div>}
    </div>
  );
}

/** Open rows stay open across new events: `opened` lives in the pane. */
function ToolRow({ tool, opened, onToggle }: { tool: ToolItem; opened: boolean; onToggle: (id: string) => void }) {
  const Icon = TOOL_ICONS[tool.toolKind];
  const open = opened;
  const failed = tool.status === 'failed';
  const diff = tool.toolKind === 'edit' && !failed ? editDiff(tool.input) : null;
  const preview = !open && !!tool.output.trim() && (failed || tool.toolKind === 'execute');
  return (
    <div data-chat-item={tool.id} className="chat-work">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(tool.id)}
        className={cn('flex w-full items-center gap-2 rounded px-1 text-left font-code text-muted-foreground hover:bg-muted', FOCUS, TARGET)}
      >
        <Icon className="size-3.5 flex-shrink-0" strokeWidth={1.8} />
        <span className={cn('min-w-0 flex-1 truncate', failed && 'text-stopped-ink')}>{tool.title}</span>
        {diff && (
          <span className="flex-shrink-0">
            <span className="text-(--diff-added)">+{diff.added}</span> <span className="text-(--diff-removed)">−{diff.removed}</span>
          </span>
        )}
        <ToolStatusMark tool={tool} />
      </button>
      {preview && <OutputPreview output={tool.output} onOpen={() => onToggle(tool.id)} />}
      {open && (
        <>
          {tool.approval && <div className="px-1 pt-0.5 text-muted-foreground">{OUTCOME_LABEL[tool.approval]}</div>}
          <div className="relative">
            {diff ? <DiffBlock lines={diff.lines} /> : (
              <pre className="mt-1 mb-1 max-h-72 overflow-auto rounded bg-muted p-2 pr-8 font-code whitespace-pre-wrap break-words text-foreground">
                {tool.output || (tool.status === 'running' ? 'Running…' : 'No output')}
              </pre>
            )}
            <button
              type="button"
              aria-label="Copy the call and its output"
              title="Copy the call and its output"
              onClick={() => { void copyTextToClipboard(tool.output ? `${tool.title}\n\n${tool.output}` : tool.title); }}
              className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'absolute top-1 right-1 rounded-md')}
            >
              <Copy aria-hidden className="size-3.5" strokeWidth={1.8} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ThinkingRow({ item, opened, onToggle }: { item: Extract<FoldedItem, { type: 'thinking' }>; opened: boolean; onToggle: (id: string) => void }) {
  return (
    <div data-chat-item={item.id} className="chat-work">
      <button
        type="button"
        aria-expanded={opened}
        onClick={() => onToggle(item.id)}
        className={cn('flex w-full items-center gap-2 rounded px-1 text-left text-muted-foreground hover:bg-muted', FOCUS, TARGET)}
      >
        <Brain className="size-3.5 flex-shrink-0" strokeWidth={1.8} />
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

function ToolGroup({ tools, id, opened, onToggle }: { tools: FoldedItem[]; id: string; opened: Set<string>; onToggle: (id: string) => void }) {
  if (tools.length === 1) return <FoldedRow item={tools[0]} opened={opened} onToggle={onToggle} />;
  const groupKey = `group:${id}`;
  const open = opened.has(groupKey);
  const running = tools.some((item) => (item.type === 'tool' ? item.status === 'running' : item.streaming));
  return (
    <div className="chat-work">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(groupKey)}
        className={cn('flex w-full items-center gap-2 rounded px-1 text-left text-muted-foreground hover:bg-muted', FOCUS, TARGET)}
      >
        <ChevronRight className={cn('size-3.5 flex-shrink-0 transition-transform', open && 'rotate-90')} strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate">{foldSummary(tools)}</span>
        {running && <Loader2 className="size-3.5 flex-shrink-0 animate-spin" aria-label="Running" />}
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
  const code = 'max-h-72 overflow-auto rounded bg-muted p-2 font-code whitespace-pre-wrap break-words';
  if (typeof input.command === 'string') return <pre className={code}>{input.command}</pre>;
  if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
    return (
      <div className="space-y-1">
        {path && <div className="font-code break-all">{path}</div>}
        <pre className={code}>
          {String(input.old_string ?? '').split('\n').map((line, i) => <div key={`o${i}`} className="text-(--diff-removed)">- {line}</div>)}
          {String(input.new_string ?? '').split('\n').map((line, i) => <div key={`n${i}`} className="text-(--diff-added)">+ {line}</div>)}
        </pre>
      </div>
    );
  }
  if (typeof input.content === 'string') {
    return (
      <div className="space-y-1">
        {path && <div className="font-code break-all">{path}</div>}
        <pre className={code}>{input.content}</pre>
      </div>
    );
  }
  return <pre className={code}>{JSON.stringify(input, null, 2)}</pre>;
}

function SettledRow({ label, outcome }: { label: string; outcome: RequestOutcome }) {
  return <div className="px-1 text-muted-foreground">{OUTCOME_LABEL[outcome]}: <span className="font-code">{label}</span></div>;
}

function PermissionCard({ item, onAnswer }: { item: PermissionItem; onAnswer: (id: string, reply: PermissionReply) => void }) {
  if (item.outcome) return <SettledRow label={item.title} outcome={item.outcome} />;
  const button = CARD_BUTTON;
  return (
    <div className="space-y-2 rounded-xl border border-status-you/40 bg-card p-3">
      {/* Plain text: tool and server names come from configuration. */}
      <div className="font-code font-medium break-words">{item.title}</div>
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
              'rounded-lg border border-border px-3 py-1.5 text-left hover:bg-muted', FOCUS, TARGET,
              picked.includes(option.label) && 'border-foreground bg-muted',
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
        className={FIELD}
      />
    </div>
  );
}

function QuestionCard({ item, onAnswer }: { item: QuestionItem; onAnswer: (id: string, reply: PermissionReply) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (item.outcome) return <SettledRow label={item.questions[0]?.question ?? 'Question'} outcome={item.outcome} />;
  const complete = item.questions.every((question) => answers[question.question]?.trim());
  return (
    <div className="space-y-3 rounded-xl border border-status-you/40 bg-card p-3">
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
          className={CARD_BUTTON}
        >
          Answer
        </button>
        <button
          type="button"
          onClick={() => onAnswer(item.id, { decision: 'deny' })}
          className={CARD_BUTTON}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function JumpToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const compact = useCompactLayout();
  if (isAtBottom) return null;
  return (
    <button
      type="button"
      onClick={() => { void scrollToBottom(); }}
      className={cn('absolute bottom-2 left-1/2 z-(--z-chat-jump) flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card px-3 py-1 shadow-raised', FOCUS, TARGET)}
      style={compact ? { bottom: 'calc(var(--composer-offset) + var(--spacing) * 2)' } : undefined}
    >
      <ArrowDown aria-hidden className="size-3" /> Jump to latest
    </button>
  );
}

/**
 * The library follows the content's size only. A phone's keyboard and a growing input
 * shrink the view around it instead, which would leave the newest lines hidden. Whether
 * the reader was at the bottom is measured, not taken from the library's lock: an iOS
 * bounce at the bottom scrolls up a little and releases that lock.
 */
function FollowOnViewResize() {
  const { scrollRef } = useStickToBottomContext();
  useEffect(() => {
    const view = scrollRef.current;
    if (!view || typeof ResizeObserver === 'undefined') return undefined;
    let height = view.clientHeight;
    const observer = new ResizeObserver(() => {
      if (wasAtBottom(view, height)) view.scrollTop = view.scrollHeight;
      height = view.clientHeight;
    });
    observer.observe(view);
    return () => observer.disconnect();
  }, [scrollRef]);
  return null;
}

/** Lets the pane re-pin the scroll when a sent message arrives. */
function PinOnSend({ pinRef, unpinRef }: { pinRef: React.MutableRefObject<(() => void) | null>; unpinRef: React.MutableRefObject<(() => void) | null> }) {
  const { scrollToBottom, stopScroll } = useStickToBottomContext();
  useEffect(() => {
    pinRef.current = () => { void scrollToBottom(); };
    unpinRef.current = stopScroll;
    return () => { pinRef.current = null; unpinRef.current = null; };
  }, [pinRef, unpinRef, scrollToBottom, stopScroll]);
  return null;
}

const STATUS_WORD: Record<string, string> = { done: 'Done', question: 'Question', review: 'Check this', failed: 'Failed' };

/** How the session said it stands at the end of its turn: a label above its closing summary. */
function StatusLabel({ status, reason }: { status: string; reason: string | null }) {
  const needsYou = status === 'question' || status === 'failed';
  return (
    <div className="flex min-w-0 items-baseline gap-2 px-1">
      <Chip hue={status === 'failed' ? 'stopped' : needsYou ? 'you' : undefined} className="flex-shrink-0 py-0.5">
        {STATUS_WORD[status] ?? status}
      </Chip>
      {reason && <span className="min-w-0 text-muted-foreground break-words">{reason}</span>}
    </div>
  );
}

const Messages = memo(function Messages({
  items, agents, agentTools, opened, onToggle: toggle, onAnswer, onStopAgent,
}: {
  items: ChatItem[];
  agents: AgentTask[];
  agentTools: Record<string, AgentTool[]>;
  opened: Set<string>;
  onToggle: (id: string) => void;
  onAnswer: (id: string, reply: PermissionReply) => void;
  onStopAgent: (taskId: string) => void;
}) {
  const groups = useMemo(() => groupItems(items), [items]);
  return (
    <div role="log" aria-live="off" className={cn(COLUMN, 'space-y-4 pt-4 pb-1')}>
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
        if (group.kind === 'status') return <StatusLabel key={group.id} status={group.status} reason={group.reason} />;
        const { item } = group;
        switch (item.type) {
          case 'user':
            return (
              <div key={item.id} data-chat-item={item.id} className="flex flex-col items-end gap-1 pt-2">
                {item.images.length > 0 && (
                  <div className="flex max-w-(--size-chat-bubble) flex-wrap justify-end gap-1">
                    {item.images.map((image, index) => (image.url ? (
                      <a key={image.url} href={image.url} target="_blank" rel="noreferrer">
                        <img src={image.url} alt="Pasted" className="max-h-40 rounded-md border border-border" />
                      </a>
                    ) : (
                      // A stored image has nothing else to tell it apart.
                      <span key={index} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-muted-foreground">
                        <ImageIcon aria-hidden className="size-3.5" strokeWidth={1.8} /> Image
                      </span>
                    )))}
                  </div>
                )}
                {item.text && <div className="max-w-(--size-chat-bubble) rounded-2xl bg-muted px-3 py-1.5 whitespace-pre-wrap break-words">{item.text}</div>}
                {item.queued && <span className="text-muted-foreground">queued</span>}
              </div>
            );
          case 'assistant':
            return <div key={item.id} data-chat-item={item.id}><Assistant text={item.text} streaming={item.streaming} /></div>;
          case 'permission':
            return <PermissionCard key={item.id} item={item} onAnswer={onAnswer} />;
          case 'question':
            return <QuestionCard key={item.id} item={item} onAnswer={onAnswer} />;
          case 'notice':
            return <div key={item.id} className="px-1 text-muted-foreground">{item.text}</div>;
          case 'error':
            return <div key={item.id} role="alert" className="rounded-lg border border-status-stopped/40 px-3 py-2 text-stopped-ink break-words">{item.text}</div>;
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
  paneId, projectId, sessionId, session, isActive, whenIdle = false, spaceId,
}: {
  paneId: string; projectId: string; sessionId: string; session: ProjectSession | null; isActive: boolean; whenIdle?: boolean;
  /** Outside the desks (the review screen): the session's space, which a pane takes from its desk. */
  spaceId?: string | null;
}) {
  const { chat, connection, switching, problem, terminalBusy, toolServers, toolServersError } = useChatSession(sessionId);
  const { start, send, interrupt, answer, setMode, setModel, stopAgent, reconnect, takeOver, askToolServers, changeToolServer } = useChatSocket(paneId, projectId, sessionId, whenIdle, spaceId);
  const pinRef = useRef<(() => void) | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [serversOpen, setServersOpen] = useState(false);
  const running = chat.activity !== 'idle';
  const unpinRef = useRef<(() => void) | null>(null);
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [searching, setSearching] = useState(false);
  const toggle = useCallback((id: string) => {
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const reveal = useCallback((keys: string[]) => {
    setOpened((prev) => (keys.every((key) => prev.has(key)) ? prev : new Set([...prev, ...keys])));
  }, []);
  const itemsRef = useRef(chat.items);
  itemsRef.current = chat.items;
  const expandLatest = useCallback(() => {
    const id = latestToolId(itemsRef.current);
    if (!id) return;
    const keys = keysToReveal(itemsRef.current, id);
    setOpened((prev) => {
      const next = new Set(prev);
      // Closing leaves the group open: it may hold other rows being read.
      if (prev.has(id)) next.delete(id); else keys.forEach((key) => next.add(key));
      return next;
    });
  }, []);
  const openSearch = useCallback(() => setSearching(true), []);
  const closeSearch = useCallback(() => setSearching(false), []);
  useChatShortcuts(rootRef, running, isActive, interrupt, expandLatest, openSearch);
  const status = switching
    ?? (connection === 'closed' ? 'Reconnecting…' : connection === 'connecting' ? 'Connecting…' : statusLine(chat));

  const onSend = useCallback((text: string, images: string[]) => {
    if (text.trim() === '/mcp' && images.length === 0) { setServersOpen(true); return true; }
    const sent = send(text, images);
    if (sent) {
      pinWhenSentArrives.current = true;
      // Replied during a review: the keyboard goes back to its bar, the session stays on screen.
      returnToReviewBar(paneId);
    }
    return sent;
  }, [send, paneId]);

  // Pinned on arrival, not on send: the message comes back from the host, and an input
  // shrinking in between scrolls the view up, which the library takes for the reader's doing.
  const pinWhenSentArrives = useRef(false);
  const latestSentId = latestUserMessageId(chat.items);
  useEffect(() => {
    if (!latestSentId || !pinWhenSentArrives.current) return;
    pinWhenSentArrives.current = false;
    pinRef.current?.();
  }, [latestSentId]);

  // On a phone the input floats over the conversation, so the view keeps its height
  // and the input's height goes into the conversation's bottom padding.
  const compact = useCompactLayout();
  const inputRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = inputRef.current;
    const root = rootRef.current;
    if (!compact || !input || !root || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => root.style.setProperty('--composer-height', `${input.offsetHeight}px`));
    observer.observe(input);
    return () => observer.disconnect();
  }, [compact]);

  return (
    <div
      ref={rootRef}
      className="chat-pane relative flex h-full min-h-0 flex-col"
      // --composer-gap above the keyboard; with it closed, partly into the home indicator's inset.
      style={compact ? ({ '--composer-bottom': 'max(var(--composer-gap), calc(var(--bottom-inset, 0px) - var(--composer-gap)))', '--composer-offset': 'calc(var(--composer-height, var(--composer-height-initial)) + var(--composer-bottom))' } as React.CSSProperties) : undefined}
    >
      <StickToBottom className="relative min-h-0 flex-1 overflow-hidden" resize="smooth" initial="instant">
        <StickToBottom.Content>
          <div style={compact ? { paddingTop: 'calc(env(safe-area-inset-top) + var(--pad-chat-compact-top))', paddingBottom: 'calc(var(--composer-offset) + var(--spacing) * 3)' } : undefined}>
          <Messages items={chat.items} agents={chat.agents} agentTools={chat.agentTools} opened={opened} onToggle={toggle} onAnswer={answer} onStopAgent={stopAgent} />
          {chat.items.length === 0 && chat.process === 'unknown' && connection !== 'superseded' && !problem && !terminalBusy && (
            <div role="status" className={cn(COLUMN, 'py-6 text-center text-muted-foreground')}>Loading conversation…</div>
          )}
          {connection === 'superseded' && (
            <div className={cn(COLUMN, 'flex items-center gap-2 pb-1 text-muted-foreground')}>
              This session moved to the terminal.
              <button type="button" onClick={reconnect} className={cn('rounded underline', FOCUS, TARGET)}>Bring it back here</button>
            </div>
          )}
          </div>
        </StickToBottom.Content>
        <JumpToLatest />
        <PinOnSend pinRef={pinRef} unpinRef={unpinRef} />
        <FollowOnViewResize />
      </StickToBottom>
      {compact && <div aria-hidden="true" className="glass-edge-bottom pointer-events-none absolute inset-x-0 bottom-0 z-(--z-chat-fade)" style={{ height: 'calc(var(--composer-offset) + var(--spacing) * 4)' }} />}
      <div
        ref={inputRef}
        className={compact ? 'absolute inset-x-2 z-(--z-sticky) space-y-2' : cn(COLUMN, 'flex-shrink-0 space-y-2 pt-3 pb-(--pad-composer-bottom)')}
        style={compact ? { bottom: 'var(--composer-bottom)' } : undefined}
      >
        {problem && <div role="alert" className={cn('text-stopped-ink break-words', compact && 'rounded-lg border border-border bg-card px-3 py-2')}>{problem}</div>}
        {searching && (
          <ChatSearch
            items={chat.items}
            opened={opened}
            root={rootRef}
            onReveal={reveal}
            onUnpin={() => unpinRef.current?.()}
            onClose={closeSearch}
          />
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
        {terminalBusy ? (
          <div role="status" className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
            <span className="min-w-0 flex-1">
              {terminalBusy === 'waiting' ? 'The terminal is waiting for an answer.' : 'Working in the terminal. This opens here when the turn ends.'}
            </span>
            <button type="button" onClick={takeOver} className={cn(CARD_BUTTON, 'flex-shrink-0')}>
              Take over
            </button>
          </div>
        ) : (
        <Composer
          sessionId={sessionId}
          running={running}
          status={status}
          chat={chat}
          onUse={start}
          onSend={onSend}
          onStop={interrupt}
          onSetMode={setMode}
          onStopAgent={stopAgent}
          session={session}
          onSetModel={setModel}
        />
        )}
        {!compact && <TerminalStatusBar
          session={session}
          live={{ model: chat.model, contextTokens: chat.context?.usedTokens ?? null, contextWindow: chat.context?.maxTokens ?? null }}
          modelSlot={<div><ModelPicker chat={chat} onSetModel={setModel} /></div>}
          className="mt-0 border-t-0 px-1 pt-0.5 text-muted-foreground"
        />}
      </div>
    </div>
  );
}
