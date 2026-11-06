// The input: text, the `/` command menu, the mode switch and what runs in the
// background, one container. The model picker sits in the status bar below it,
// and on a phone, where there is no status bar, behind the context chip.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Check, ChevronDown, Cpu, Gauge, Loader2, Paperclip, Shield, Square, Terminal, Users, X } from 'lucide-react';

import { contextWindow, formatAge, formatTokens, modelLabel } from '@/components/main-content/view/subcomponents/TerminalStatusBar';
import { uploadPastedImage } from '@/components/shell/utils/hostChannel';
import { useCompactLayout } from '@/hooks/useCompactLayout';
import { cn } from '@/lib/utils';
import type { ProjectSession } from '@/types/app';

import { currentModelOption, matchCommands, sentMessages, stepHistory, type ChatState, type CommandInfo } from './chat-state';
import { readDraft, writeDraft } from './chat-store';
import { pasteTextDirectly } from './pasteText';
import { TARGET } from './tool-icons';

/** A small button opening a list above it. */
function ChipMenu({
  label, icon, title, children, align = 'left', disabled = false, chevron = true,
}: {
  label: ReactNode;
  icon: ReactNode;
  title: string;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'center' | 'right';
  disabled?: boolean;
  chevron?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); } };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div ref={root} className="relative min-w-0">
      <button
        type="button"
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn('flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-foreground/5 disabled:opacity-60', TARGET)}
      >
        {icon}
        <span className="truncate">{label}</span>
        {chevron && !disabled && <ChevronDown className="h-3 w-3 flex-shrink-0" strokeWidth={1.8} />}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute bottom-full z-30 mb-1 max-h-72 w-80 max-w-[80vw] overflow-auto rounded-lg border border-border bg-card p-1 shadow-lg',
            align === 'center' ? 'left-1/2 -translate-x-1/2' : align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuOption({
  label, description, checked, onSelect,
}: { label: string; description: string; checked: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn('flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-foreground/5', TARGET)}
    >
      <Check className={cn('mt-1 h-3.5 w-3.5 flex-shrink-0', !checked && 'invisible')} strokeWidth={2} />
      <span className="min-w-0">
        <span className="block text-foreground">{label}</span>
        {description && <span className="block text-muted-foreground">{description}</span>}
      </span>
    </button>
  );
}

export function ModelPicker({ chat, onSetModel }: { chat: ChatState; onSetModel: (model: string) => boolean }) {
  const current = currentModelOption(chat);
  const label = chat.model ? modelLabel(chat.model) : current?.label ?? '—';
  return (
    <div className="justify-self-center">
      <ChipMenu
        label={label}
        title={chat.model ?? 'Model'}
        align="center"
        disabled={chat.models.length === 0}
        icon={<Cpu className="h-3 w-3 flex-shrink-0" strokeWidth={1.8} />}
      >
        {(close) => chat.models.map((option) => (
          <MenuOption
            key={option.id}
            label={option.label}
            description={option.description}
            checked={option === current}
            onSelect={() => { onSetModel(option.id); close(); }}
          />
        ))}
      </ChipMenu>
    </div>
  );
}

/** The phone's short context reading; a tap gives the rest of the desktop status bar. */
function ContextChip({ chat, session, onSetModel }: { chat: ChatState; session: ProjectSession | null; onSetModel: (model: string) => boolean }) {
  const current = currentModelOption(chat);
  const tokens = chat.context?.usedTokens ?? session?.contextTokens ?? null;
  const model = chat.model ?? session?.model ?? null;
  const maxTokens = chat.context?.maxTokens ?? contextWindow(model);
  const percent = tokens !== null ? `${Math.min(100, Math.round((tokens / maxTokens) * 100))}%` : '—';
  const lastMessageAt = session?.lastMessageAt ?? null;
  return (
    <div className="flex-shrink-0">
      <ChipMenu label={percent} title="Session details" align="right" chevron={false} icon={<Gauge className="h-3 w-3 flex-shrink-0" strokeWidth={1.8} />}>
        {(close) => (
          <>
            <div className="flex justify-between gap-2 px-2 py-1">
              <span className="text-muted-foreground">Context</span>
              <span>{tokens !== null ? `${formatTokens(tokens)} / ${formatTokens(maxTokens)} · ${percent}` : '—'}</span>
            </div>
            <div className="flex justify-between gap-2 px-2 py-1">
              <span className="text-muted-foreground">Last message</span>
              <span>{lastMessageAt ? formatAge(lastMessageAt, new Date()) : 'none yet'}</span>
            </div>
            <div className="mt-1 flex justify-between gap-2 border-t border-border px-2 pt-2 pb-1">
              <span className="text-muted-foreground">Model</span>
              <span>{model ? modelLabel(model) : current?.label ?? '—'}</span>
            </div>
            {chat.models.map((option) => (
              <MenuOption
                key={option.id}
                label={option.label}
                description={option.description}
                checked={option === current}
                onSelect={() => { onSetModel(option.id); close(); }}
              />
            ))}
          </>
        )}
      </ChipMenu>
    </div>
  );
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What runs beside the conversation: subagents and background shells. */
function BackgroundChip({ chat, onStop }: { chat: ChatState; onStop: (taskId: string) => void }) {
  const agents = chat.agents.filter((agent) => agent.status === 'running');
  const shells = chat.shells.filter((shell) => shell.status === 'running');
  if (agents.length + shells.length === 0) return null;
  const row = (taskId: string, icon: ReactNode, title: string, detail: string | null) => (
    <div key={taskId} className="flex items-center gap-2 px-2 py-1.5">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-foreground" title={title}>{title}</span>
        {detail && <span className="block truncate text-muted-foreground">{detail}</span>}
      </span>
      <button type="button" aria-label={`Stop ${title}`} onClick={() => onStop(taskId)} className={cn('flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground', TARGET)}>
        <Square className="h-3.5 w-3.5" strokeWidth={1.8} />
      </button>
    </div>
  );
  const iconClass = 'h-3.5 w-3.5 flex-shrink-0 text-muted-foreground';
  return (
    <ChipMenu
      label={[agents.length ? count(agents.length, 'agent') : '', shells.length ? count(shells.length, 'shell') : ''].filter(Boolean).join(' · ')}
      title="Running in the background"
      icon={<Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" strokeWidth={1.8} />}
    >
      {() => [
        ...agents.map((agent) => row(agent.taskId, <Users className={iconClass} strokeWidth={1.8} />, agent.description, agent.activity)),
        ...shells.map((shell) => row(shell.taskId, <Terminal className={iconClass} strokeWidth={1.8} />, shell.description, null)),
      ]}
    </ChipMenu>
  );
}

function CommandMenu({
  commands, active, onHover, onPick,
}: { commands: CommandInfo[]; active: number; onHover: (index: number) => void; onPick: (command: CommandInfo) => void }) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [active]);
  return (
    <div role="listbox" aria-label="Commands" className="absolute right-0 bottom-full left-0 z-30 mb-1 max-h-64 overflow-auto rounded-lg border border-border bg-card p-1 shadow-lg">
      {commands.map((command, index) => (
        <button
          key={command.name}
          ref={index === active ? activeRef : undefined}
          type="button"
          role="option"
          aria-selected={index === active}
          onMouseEnter={() => onHover(index)}
          // Keeps the focus in the textarea.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(command)}
          className={cn('flex w-full items-baseline gap-2 rounded px-2 py-1 text-left', TARGET, index === active && 'bg-foreground/5')}
        >
          <span className="flex-shrink-0 font-mono text-foreground">/{command.name}</span>
          {command.argumentHint && <span className="flex-shrink-0 font-mono text-muted-foreground">{command.argumentHint}</span>}
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{command.description}</span>
        </button>
      ))}
    </div>
  );
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// What the model takes per image; the host refuses more as well.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface Attachment {
  id: number;
  preview: string;
  /** The stored file's name; null while it uploads. */
  name: string | null;
}

export function Composer({
  sessionId, running, status, chat, onUse, onSend, onStop, onSetMode, onStopAgent, session, onSetModel,
}: {
  sessionId: string;
  running: boolean;
  /** One short line on what is going on; empty when nothing is. */
  status: string | null;
  chat: ChatState;
  /** The user reaches for the input: a read-only session gets its process now. An input focused on its own says nothing. */
  onUse: () => void;
  onSend: (text: string, images: string[]) => boolean;
  onStop: () => void;
  onSetMode: (mode: string) => boolean;
  onStopAgent: (taskId: string) => void;
  session: ProjectSession | null;
  onSetModel: (model: string) => boolean;
}) {
  const compact = useCompactLayout();
  const [draft, setDraft] = useState(() => readDraft(sessionId));
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Going through sent messages with the arrow keys; typing ends it.
  const [recalled, setRecalled] = useState<number | null>(null);
  const draftBeforeRecall = useRef('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachProblem, setAttachProblem] = useState<string | null>(null);
  const nextAttachment = useRef(0);
  const filePicker = useRef<HTMLInputElement>(null);
  const previews = useRef(new Set<string>());
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(readDraft(sessionId)); }, [sessionId]);
  useEffect(() => {
    const open = previews.current;
    return () => { open.forEach((preview) => URL.revokeObjectURL(preview)); open.clear(); };
  }, []);
  // The field grows with its text; the stylesheet's max-height bounds it.
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);

  const matches = useMemo(() => (dismissed ? [] : matchCommands(chat.commands, draft)), [chat.commands, draft, dismissed]);
  const selected = Math.min(active, Math.max(matches.length - 1, 0));

  const change = (text: string) => {
    setDraft(text);
    writeDraft(sessionId, text);
    setActive(0);
    setDismissed(false);
    setRecalled(null);
  };
  const recall = (step: -1 | 1) => {
    const sent = sentMessages(chat.items);
    const next = stepHistory(sent.length, recalled, step);
    if (recalled === null) draftBeforeRecall.current = draft;
    setRecalled(next);
    setDraft(next === null ? draftBeforeRecall.current : sent[next]);
  };
  const removeAttachment = (id: number) => {
    setAttachments((current) => current.filter((attachment) => {
      if (attachment.id !== id) return true;
      URL.revokeObjectURL(attachment.preview);
      previews.current.delete(attachment.preview);
      return false;
    }));
  };
  const addFiles = (files: File[]) => {
    setAttachProblem(null);
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) { setAttachProblem('Only PNG, JPEG, GIF and WebP images can be attached.'); continue; }
      if (file.size > MAX_IMAGE_BYTES) { setAttachProblem('An image can be at most 5 MB.'); continue; }
      const id = nextAttachment.current;
      nextAttachment.current += 1;
      const preview = URL.createObjectURL(file);
      previews.current.add(preview);
      setAttachments((current) => [...current, { id, preview, name: null }]);
      void uploadPastedImage(file, file.type).catch(() => null).then((path) => {
        const name = path?.split(/[\\/]/).pop() ?? null;
        if (!name) {
          setAttachProblem('The image could not be uploaded.');
          removeAttachment(id);
          return;
        }
        setAttachments((current) => current.map((attachment) => (attachment.id === id ? { ...attachment, name } : attachment)));
      });
    }
  };
  const uploading = attachments.some((attachment) => attachment.name === null);
  const canSend = (text: string) => !uploading && (!!text.trim() || attachments.length > 0);
  const sendText = (text: string) => {
    if (!canSend(text) || !onSend(text, attachments.flatMap((attachment) => (attachment.name ? [attachment.name] : [])))) return;
    change('');
    attachments.forEach((attachment) => removeAttachment(attachment.id));
    setAttachProblem(null);
  };
  const insert = (command: CommandInfo) => {
    change(`/${command.name} `);
    input.current?.focus();
  };

  const mode = chat.modes.find((option) => option.id === chat.mode) ?? null;
  const cycleMode = () => {
    if (chat.modes.length === 0) return;
    const index = chat.modes.findIndex((option) => option.id === chat.mode);
    onSetMode(chat.modes[(index + 1) % chat.modes.length].id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); cycleMode(); return; }
    if (matches.length > 0) {
      const command = matches[selected];
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((selected + 1) % matches.length); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((selected - 1 + matches.length) % matches.length); return; }
      if (event.key === 'Tab') { event.preventDefault(); insert(command); return; }
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
      if (event.key === 'Enter' && !event.shiftKey && !compact) {
        event.preventDefault();
        // A command that takes arguments waits for them; any other runs, as in the terminal.
        if (command.argumentHint) insert(command); else sendText(`/${command.name}`);
        return;
      }
    }
    if (compact) return;
    // As in a terminal, but never at the cost of moving around in a text being written.
    if (event.key === 'ArrowUp' && (recalled !== null || !draft)) { event.preventDefault(); recall(-1); return; }
    if (event.key === 'ArrowDown' && recalled !== null) { event.preventDefault(); recall(1); return; }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendText(draft); }
    else if (event.key === 'Escape' && running) { event.preventDefault(); onStop(); }
  };

  // 28 px to see; on a phone the ::after keeps the tap area at 44 px.
  const iconButton = "relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full after:absolute after:-inset-2 after:content-[''] md:after:hidden";
  return (
    <div className="relative">
      {matches.length > 0 && <CommandMenu commands={matches} active={selected} onHover={setActive} onPick={insert} />}
      <div
        className={compact ? 'glass-field rounded-3xl' : 'rounded-xl border border-border bg-card shadow-sm transition-shadow focus-within:border-foreground/30 focus-within:shadow-md'}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files);
          if (files.length === 0) return;
          event.preventDefault();
          addFiles(files);
        }}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2.5">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="relative">
                <img src={attachment.preview} alt="To send" className={cn('h-16 rounded-md border border-border', attachment.name === null && 'opacity-50')} />
                <button
                  type="button"
                  aria-label="Remove image"
                  onClick={() => removeAttachment(attachment.id)}
                  className="absolute -top-1.5 -right-1.5 rounded-full border border-border bg-card p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachProblem && <div role="alert" className="px-3 pt-2 text-destructive">{attachProblem}</div>}
        <textarea
          ref={input}
          aria-label="Message"
          rows={1}
          value={draft}
          placeholder={running ? 'Queue a message…' : 'Message, or / for commands'}
          onPointerDown={onUse}
          onChange={(event) => {
            if (!draft) onUse();
            change(event.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
            if (files.length === 0) { pasteTextDirectly(event); return; }
            event.preventDefault();
            addFiles(files);
          }}
          className="block max-h-48 min-h-0 w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-1 outline-none"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1 max-md:[&>*]:-my-2">
          <input
            ref={filePicker}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            multiple
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <button
            type="button"
            aria-label="Attach an image"
            title="Attach an image (or paste or drop one)"
            onClick={() => filePicker.current?.click()}
            className={cn('flex items-center rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-foreground/5', TARGET)}
          >
            <Paperclip className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
          <ChipMenu
            label={mode?.label ?? 'Mode'}
            title="Permission mode (Shift+Tab)"
            disabled={chat.modes.length === 0}
            icon={<Shield className="h-3 w-3 flex-shrink-0" strokeWidth={1.8} />}
          >
            {(close) => chat.modes.map((option) => (
              <MenuOption
                key={option.id}
                label={option.label}
                description={option.description}
                checked={option.id === chat.mode}
                onSelect={() => { onSetMode(option.id); close(); }}
              />
            ))}
          </ChipMenu>
          <BackgroundChip chat={chat} onStop={onStopAgent} />
          <div role="status" className={cn('min-w-0 flex-1 truncate px-1', compact ? 'text-left text-foreground' : 'text-right text-muted-foreground')}>{status}</div>
          {compact && <ContextChip chat={chat} session={session} onSetModel={onSetModel} />}
          {running && (
            <button type="button" aria-label="Stop" onClick={onStop} className={cn(iconButton, 'border border-border hover:bg-foreground/5')}>
              <Square className="h-3.5 w-3.5" />
            </button>
          )}
          {(!running || draft.trim() || attachments.length > 0) && (
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend(draft)}
              onClick={() => sendText(draft)}
              className={cn(iconButton, 'bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30')}
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
