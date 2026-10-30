// The input: text, the `/` command menu, the mode switch and what runs in the
// background, one container. The model picker sits in the status bar below it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Check, ChevronDown, Cpu, Loader2, Shield, Square, Users } from 'lucide-react';

import { modelLabel } from '@/components/main-content/view/subcomponents/TerminalStatusBar';
import { useCompactLayout } from '@/hooks/useCompactLayout';
import { cn } from '@/lib/utils';

import { currentModelOption, matchCommands, type ChatState, type CommandInfo } from './chat-state';
import { readDraft, writeDraft } from './chat-store';
import { TARGET } from './tool-icons';

/** A small button opening a list above it. */
function ChipMenu({
  label, icon, title, children, align = 'left', disabled = false,
}: {
  label: ReactNode;
  icon: ReactNode;
  title: string;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'center';
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
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
        {!disabled && <ChevronDown className="h-3 w-3 flex-shrink-0" strokeWidth={1.8} />}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute bottom-full z-30 mb-1 max-h-72 w-80 max-w-[80vw] overflow-auto rounded-lg border border-border bg-card p-1 shadow-lg',
            align === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-0',
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

function AgentsChip({ chat, onStop }: { chat: ChatState; onStop: (taskId: string) => void }) {
  const running = chat.agents.filter((agent) => agent.status === 'running');
  if (running.length === 0) return null;
  return (
    <ChipMenu
      label={`${running.length} ${running.length === 1 ? 'agent' : 'agents'}`}
      title="Running subagents"
      icon={<Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" strokeWidth={1.8} />}
    >
      {() => running.map((agent) => (
        <div key={agent.taskId} className="flex items-center gap-2 px-2 py-1.5">
          <Users className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" strokeWidth={1.8} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-foreground">{agent.description}</span>
            {agent.activity && <span className="block truncate text-muted-foreground">{agent.activity}</span>}
          </span>
          <button type="button" onClick={() => onStop(agent.taskId)} className={cn('flex-shrink-0 rounded px-2 py-1 text-muted-foreground hover:bg-foreground/5', TARGET)}>
            Stop
          </button>
        </div>
      ))}
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

export function Composer({
  sessionId, running, chat, onSend, onStop, onSetMode, onStopAgent,
}: {
  sessionId: string;
  running: boolean;
  chat: ChatState;
  onSend: (text: string) => boolean;
  onStop: () => void;
  onSetMode: (mode: string) => boolean;
  onStopAgent: (taskId: string) => void;
}) {
  const compact = useCompactLayout();
  const [draft, setDraft] = useState(() => readDraft(sessionId));
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(readDraft(sessionId)); }, [sessionId]);
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
  };
  const sendText = (text: string) => {
    if (!text.trim() || !onSend(text)) return;
    change('');
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
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendText(draft); }
    else if (event.key === 'Escape' && running) { event.preventDefault(); onStop(); }
  };

  const iconButton = cn('flex h-8 min-w-11 items-center justify-center rounded-full md:w-8 md:min-w-0', TARGET);
  return (
    <div className="relative">
      {matches.length > 0 && <CommandMenu commands={matches} active={selected} onHover={setActive} onPick={insert} />}
      <div className="rounded-xl border border-border bg-card shadow-sm transition-shadow focus-within:border-foreground/30 focus-within:shadow-md">
        <textarea
          ref={input}
          aria-label="Message"
          rows={1}
          value={draft}
          placeholder={running ? 'Queue a message…' : 'Message, or / for commands'}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          className="block max-h-48 min-h-0 w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-1 outline-none"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
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
          <AgentsChip chat={chat} onStop={onStopAgent} />
          <div className="flex-1" />
          {running && (
            <button type="button" aria-label="Stop" onClick={onStop} className={cn(iconButton, 'border border-border hover:bg-foreground/5')}>
              <Square className="h-4 w-4" />
            </button>
          )}
          {(!running || draft.trim()) && (
            <button
              type="button"
              aria-label="Send"
              disabled={!draft.trim()}
              onClick={() => sendText(draft)}
              className={cn(iconButton, 'bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30')}
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
