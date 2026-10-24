import { useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, SendHorizontal } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { TerminalKey } from '../../domain/terminalKeys';
import type { ShellInput } from '../../hooks/useShellRuntime';

/**
 * Terminal input on a phone (compact layout): a row of the keys a soft
 * keyboard lacks, quick answers for numbered prompts, and a composer — a
 * native text field, so autocorrect, dictation and paste work — whose message
 * goes in as one paste plus Enter.
 */

type RowItem =
  | { kind: 'key'; key: TerminalKey; label: React.ReactNode; title: string }
  | { kind: 'text'; text: string };

const ROW: RowItem[] = [
  { kind: 'key', key: 'escape', label: 'Esc', title: 'Escape' },
  { kind: 'key', key: 'shift-tab', label: '⇧Tab', title: 'Shift+Tab' },
  { kind: 'key', key: 'tab', label: 'Tab', title: 'Tab' },
  { kind: 'key', key: 'up', label: <ArrowUp className="h-4 w-4" />, title: 'Up' },
  { kind: 'key', key: 'down', label: <ArrowDown className="h-4 w-4" />, title: 'Down' },
  { kind: 'key', key: 'left', label: <ArrowLeft className="h-4 w-4" />, title: 'Left' },
  { kind: 'key', key: 'right', label: <ArrowRight className="h-4 w-4" />, title: 'Right' },
  { kind: 'key', key: 'enter', label: <CornerDownLeft className="h-4 w-4" />, title: 'Enter' },
  { kind: 'text', text: '1' },
  { kind: 'text', text: '2' },
  { kind: 'text', text: '3' },
  { kind: 'key', key: 'interrupt', label: '^C', title: 'Ctrl+C' },
];

const KEY_CLASS =
  'flex h-9 min-w-[2.75rem] flex-shrink-0 items-center justify-center rounded-md border border-foreground/15 bg-foreground/[0.04] px-2 font-mono text-[13px] text-foreground active:bg-foreground/15';

export default function TerminalTouchInput({ input, disabled }: { input: ShellInput; disabled: boolean }) {
  const [draft, setDraft] = useState('');
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    input.submit(draft);
    setDraft('');
  };

  // A key tap must not take focus from the composer: on iOS that closes the
  // keyboard, and the next tap would raise it again.
  const keepFocus = (event: React.PointerEvent) => event.preventDefault();

  return (
    <div className={cn('flex flex-shrink-0 flex-col gap-1.5 border-t border-foreground/15 pt-1.5', disabled && 'pointer-events-none opacity-50')}>
      <div className="flex gap-1.5 overflow-x-auto" role="toolbar" aria-label="Terminal keys">
        {ROW.map((item) => (
          <button
            key={item.kind === 'key' ? item.key : item.text}
            type="button"
            className={KEY_CLASS}
            title={item.kind === 'key' ? item.title : `Type ${item.text}`}
            aria-label={item.kind === 'key' ? item.title : `Type ${item.text}`}
            onPointerDown={keepFocus}
            onClick={() => (item.kind === 'key' ? input.sendKey(item.key) : input.sendText(item.text))}
          >
            {item.kind === 'key' ? item.label : item.text}
          </button>
        ))}
      </div>
      <form
        className="flex items-end gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={fieldRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={1}
          placeholder="Message the agent"
          aria-label="Message the agent"
          enterKeyHint="send"
          autoCapitalize="sentences"
          // field-sizing grows the field with its text, up to the max height.
          className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-foreground/15 bg-background px-2.5 py-2 text-base leading-snug [field-sizing:content] focus:border-primary/60 focus:outline-none"
        />
        <button
          type="submit"
          className={cn(KEY_CLASS, 'h-9 bg-primary/90 text-primary-foreground active:bg-primary')}
          title={draft.trim() ? 'Send' : 'Send Enter'}
          aria-label={draft.trim() ? 'Send' : 'Send Enter'}
          onPointerDown={keepFocus}
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
