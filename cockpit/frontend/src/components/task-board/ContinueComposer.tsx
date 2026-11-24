// The input under a closed task's chat (decision task-closing-and-continuation-rules): writing goes on with
// the work. Send reopens the task and its newest session gets the message; As follow-up starts a new task
// spun off from it. Which of the two is the main button comes from continueMode (lib/task-board.ts).
import { useRef, useState } from 'react';

import { useCompactLayout } from '@/hooks/useCompactLayout';
import type { ContinueHow, ContinueMode } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { BUTTON, FIELD, PRIMARY } from '@/shared/view/ui';

const LABEL: Record<ContinueHow, string> = { reopen: 'Send', follow_up: 'As follow-up' };
const PRIMARY_LABEL: Record<ContinueHow, string> = { reopen: 'Send', follow_up: 'Start follow-up' };
const SECONDARY_LABEL: Record<ContinueHow, string> = { reopen: 'Reopen & send', follow_up: 'As follow-up' };
const PLACEHOLDER: Record<ContinueHow, string> = {
  reopen: 'Continue… (reopens the task)',
  follow_up: 'What should the follow-up do? (starts a new task)',
};

export function ContinueComposer({ mode, onSend }: {
  mode: ContinueMode;
  /** Send the text the chosen way; `restore` puts it back into the input (after Undo). False: it stays. */
  onSend: (text: string, how: ContinueHow, restore: () => void) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const compact = useCompactLayout();
  const secondary: ContinueHow | null = mode.reopen ? (mode.primary === 'reopen' ? 'follow_up' : 'reopen') : null;

  const send = async (how: ContinueHow) => {
    const text = draft;
    if (!text.trim() || busy) return;
    setBusy(true);
    setDraft('');
    const ok = await onSend(text, how, () => { setDraft(text); input.current?.focus(); });
    setBusy(false);
    if (!ok) setDraft(text);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || compact || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (event.altKey) { if (secondary) void send(secondary); }
    else void send(mode.primary);
  };

  return (
    <div aria-label="Continue this task" className="flex shrink-0 flex-col gap-2 border-t border-border p-3">
      {mode.note && <p className="m-0 text-caption text-muted-foreground">{mode.note}</p>}
      <textarea
        ref={input}
        aria-label={PLACEHOLDER[mode.primary]}
        placeholder={PLACEHOLDER[mode.primary]}
        value={draft}
        rows={2}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        className={cn(FIELD, 'resize-y py-2')}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {secondary && (
          <button type="button" className={BUTTON} disabled={!draft.trim() || busy} onClick={() => void send(secondary)}
            aria-keyshortcuts="Alt+Enter" title={`${LABEL[secondary]} (⌥↵)`}>
            {SECONDARY_LABEL[secondary]}
            {!compact && <kbd className="ml-1.5 font-sans text-caption text-muted-foreground">⌥↵</kbd>}
          </button>
        )}
        <button type="button" className={PRIMARY} disabled={!draft.trim() || busy} onClick={() => void send(mode.primary)}
          aria-keyshortcuts="Enter">
          {PRIMARY_LABEL[mode.primary]}
          {!compact && <kbd className="ml-1.5 font-sans text-caption opacity-70">↵</kbd>}
        </button>
      </div>
    </div>
  );
}
