import { useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  ImagePlus,
  Loader2,
  PencilLine,
  SendHorizontal,
  X,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { FOCUS } from '@/shared/view/ui';
import type { TerminalKey } from '../../domain/terminalKeys';
import type { ShellInput } from '../../hooks/useShellRuntime';

/**
 * Terminal input on a phone (compact layout). The soft keyboard types into
 * the terminal itself; this row adds what it lacks — Esc, Shift+Tab, arrows,
 * Ctrl+C, quick answers for numbered prompts — plus an image from the device
 * and, for dictation or a long prompt, a text field whose message goes in as
 * one paste plus Enter.
 */

type RowItem =
  | { kind: 'key'; key: TerminalKey; label: React.ReactNode; title: string }
  | { kind: 'text'; text: string };

const ROW: RowItem[] = [
  { kind: 'key', key: 'escape', label: 'Esc', title: 'Escape' },
  { kind: 'key', key: 'shift-tab', label: '⇧Tab', title: 'Shift+Tab' },
  { kind: 'key', key: 'tab', label: 'Tab', title: 'Tab' },
  { kind: 'key', key: 'up', label: <ArrowUp aria-hidden className="size-4" />, title: 'Up' },
  { kind: 'key', key: 'down', label: <ArrowDown aria-hidden className="size-4" />, title: 'Down' },
  { kind: 'key', key: 'left', label: <ArrowLeft aria-hidden className="size-4" />, title: 'Left' },
  { kind: 'key', key: 'right', label: <ArrowRight aria-hidden className="size-4" />, title: 'Right' },
  { kind: 'key', key: 'enter', label: <CornerDownLeft aria-hidden className="size-4" />, title: 'Enter' },
  { kind: 'text', text: '1' },
  { kind: 'text', text: '2' },
  { kind: 'text', text: '3' },
  { kind: 'key', key: 'interrupt', label: '^C', title: 'Ctrl+C' },
];

const KEY_CLASS = cn(
  'flex h-9 min-w-(--target-touch) flex-shrink-0 items-center justify-center rounded-md border border-border bg-muted px-2 font-code text-body text-foreground active:bg-foreground/12',
  FOCUS,
);

// A key tap must not take the focus from where the user types (the terminal
// or the text field): on iOS that closes the keyboard.
const keepFocus = (event: React.PointerEvent) => event.preventDefault();

export default function TerminalTouchInput({ input, disabled }: { input: ShellInput; disabled: boolean }) {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [attachFailed, setAttachFailed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const closeComposer = () => {
    setComposing(false);
    input.focus();
  };

  const submit = () => {
    input.submit(draft);
    setDraft('');
    closeComposer();
  };

  const attach = async (file: File | undefined) => {
    if (!file) return;
    setAttaching(true);
    setAttachFailed(false);
    const ok = await input.attachImage(file);
    setAttaching(false);
    setAttachFailed(!ok);
    if (ok) input.focus();
  };

  return (
    <div data-ui="v2" className={cn('flex flex-shrink-0 flex-col gap-1.5 border-t border-border pt-1.5', disabled && 'pointer-events-none opacity-50')}>
      {composing && (
        <form
          className="flex items-end gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            autoFocus
            placeholder="Write or dictate, then send"
            aria-label="Message the agent"
            autoCapitalize="sentences"
            className={cn('max-h-40 min-h-20 flex-1 resize-none rounded-md border border-input bg-background px-2.5 py-2 text-(length:--text-field-touch) leading-snug [field-sizing:content]', FOCUS)}
          />
          <div className="flex flex-col gap-1.5">
            <button type="button" className={KEY_CLASS} title="Close" aria-label="Close" onPointerDown={keepFocus} onClick={closeComposer}>
              <X aria-hidden className="size-4" />
            </button>
            <button
              type="submit"
              className={cn(KEY_CLASS, 'border-primary bg-primary text-primary-foreground active:opacity-90')}
              title="Send"
              aria-label="Send"
              onPointerDown={keepFocus}
            >
              <SendHorizontal aria-hidden className="size-4" />
            </button>
          </div>
        </form>
      )}
      {attachFailed && <p className="px-1 text-ui text-stopped-ink">The image could not be added. Try another one.</p>}
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
        <button
          type="button"
          className={KEY_CLASS}
          title="Add an image"
          aria-label="Add an image"
          disabled={attaching}
          onClick={() => fileRef.current?.click()}
        >
          {attaching ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <ImagePlus aria-hidden className="size-4" />}
        </button>
        <button
          type="button"
          className={cn(KEY_CLASS, composing && 'bg-foreground/12')}
          title="Write a longer message"
          aria-label="Write a longer message"
          aria-pressed={composing}
          onClick={() => (composing ? closeComposer() : setComposing(true))}
        >
          <PencilLine aria-hidden className="size-4" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            void attach(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
